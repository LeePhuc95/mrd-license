/**
 * =============================================================================
 * BACKEND WORKER CLOUDFLARE PAGES (_worker.js)
 * Tự động xử lý API /api/admin/* và điều phối tài nguyên tĩnh qua Cloudflare Pages CDN
 * =============================================================================
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const today = new Date().toISOString().split("T")[0];

    // =========================================================================
    // 0. BỘ ĐẾM REQUEST LICENSE (CHẠY NỀN QUA ctx.waitUntil)
    // Chỉ đếm các request API và trang quản trị thực tế
    // BỎ QUA toàn bộ tài nguyên tĩnh (icon, manifest, sw.js, favicon) để không tốn quota
    // =========================================================================
    const isStaticAsset = (
      url.pathname.endsWith(".png") ||
      url.pathname.endsWith(".svg") ||
      url.pathname.endsWith(".ico") ||
      url.pathname.endsWith(".webmanifest") ||
      (url.pathname.endsWith(".json") && !url.pathname.startsWith("/api/")) ||
      url.pathname === "/sw.js" ||
      url.pathname === "/favicon.ico" ||
      url.pathname === "/apple-touch-icon.png" ||
      url.pathname === "/apple-touch-icon-precomposed.png"
    );

    if (env.DB && !isStaticAsset) {
      ctx.waitUntil(
        env.DB.prepare(`
          INSERT INTO system_stats (date_key, service_type, req_count)
          VALUES (?, 'LICENSE', 1)
          ON CONFLICT(date_key, service_type) DO UPDATE SET req_count = req_count + 1
        `).bind(today).run().catch(e => console.error("Lỗi đếm License req:", e))
      );
    }

    // =========================================================================
    // 1. API ADMIN
    // =========================================================================
    const adminPassword = env.ADMIN_PASSWORD;
    const authHeader = request.headers.get("Authorization") || "";
    const bearerToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
    const isAuthed = (bearerToken === adminPassword) || (await verifySessionToken(bearerToken, adminPassword));

    if (url.pathname === "/api/admin/login" && request.method === "POST") {
      try {
        const { password } = await request.json();
        if (password === adminPassword) {
          const sessionToken = await generateSessionToken(adminPassword);
          return jsonResponse({ success: true, token: sessionToken });
        }
        return jsonResponse({ success: false, message: "Mật khẩu không chính xác!" }, 401);
      } catch (e) {
        return jsonResponse({ success: false, message: "Dữ liệu không hợp lệ: " + e.message }, 400);
      }
    }

    if (url.pathname === "/api/admin/init-data" && request.method === "GET") {
      if (!isAuthed) return jsonResponse({ error: "Unauthorized" }, 401);

      if (!env.DB) {
        return jsonResponse({
          error: "Chưa liên kết CSDL D1 (tên biến 'DB') trong Settings -> Functions -> D1 database bindings của Cloudflare Pages!",
          licenses: [],
          rom_categories: [],
          license_tables: ["androidtv-x86"],
          current_table: "androidtv-x86",
          pages_domain: env.PAGES_DOMAIN ? env.PAGES_DOMAIN.replace(/\/+$/, '') : '',
          license_quota: { limit: 10000, used: 0, remaining: 10000 }
        });
      }

      await ensureDbSchema(env);
      const MAX_LICENSE_REQ = 10000;

      // Xác định bảng bản quyền mục tiêu
      const reqTable = sanitizeLicenseName(url.searchParams.get("table"));
      const regListRes = await env.DB.prepare("SELECT table_name FROM license_registries ORDER BY created_at ASC").all();
      const allTables = (regListRes.results || []).map(r => r.table_name);
      if (allTables.length === 0) allTables.push("androidtv-x86");

      const targetTable = (reqTable && allTables.includes(reqTable)) ? reqTable : allTables[0];
      const actualTable = `${targetTable}_license`;

      // Truy vấn đồng thời dữ liệu bản quyền, sản phẩm, request quota, Gift keys, phiên bản DB và cài đặt
      const [licensesRes, romsRes, statsRes, giftKeysRes, versionRes, autoEmailRes] = await Promise.all([
        env.DB.prepare(`SELECT * FROM "${actualTable}" ORDER BY id DESC`).all().catch(() => ({ results: [] })),
        env.DB.prepare("SELECT name FROM product_categories WHERE license_table = ? ORDER BY name ASC").bind(targetTable).all(),
        env.DB.prepare("SELECT req_count FROM system_stats WHERE date_key = ? AND service_type = 'LICENSE'").bind(today).first(),
        env.DB.prepare("SELECT * FROM gift_keys WHERE license_table = ? ORDER BY created_at DESC").bind(targetTable).all(),
        env.DB.prepare("SELECT req_count FROM system_stats WHERE date_key = 'SYSTEM' AND service_type = 'DB_VERSION'").first(),
        env.DB.prepare("SELECT req_count FROM system_stats WHERE date_key = 'SETTINGS' AND service_type = 'AUTO_SEND_EMAIL'").first()
      ]);

      const licenseUsage = statsRes ? (statsRes.req_count || 0) : 0;
      const currentDbVersion = versionRes ? (versionRes.req_count || 0) : 0;
      const licensesList = (licensesRes.results || []).map(item => ({
        ...item,
        prefix: item.prefix || getDevicePrefix(item.serial)
      }));

      return jsonResponse({
        licenses: licensesList,
        rom_categories: (romsRes.results || []).map(r => r.name),
        gift_keys: giftKeysRes?.results || [],
        license_tables: allTables,
        current_table: targetTable,
        github_repo: env.GITHUB_REPO ? String(env.GITHUB_REPO).trim() : '',
        pages_domain: env.PAGES_DOMAIN ? env.PAGES_DOMAIN.replace(/\/+$/, '') : '',
        db_version: currentDbVersion,
        auto_send_email: autoEmailRes ? (autoEmailRes.req_count === 1) : false,
        license_quota: {
          limit: MAX_LICENSE_REQ,
          used: licenseUsage,
          remaining: Math.max(0, MAX_LICENSE_REQ - licenseUsage)
        }
      });
    }

    if (url.pathname === "/api/admin/action" && request.method === "POST") {
      if (!isAuthed) return jsonResponse({ error: "Unauthorized" }, 401);

      try {
        const body = await request.json();
        const { action } = body;
        const currentTable = sanitizeLicenseName(body.license_table) || "androidtv-x86";
        const actualTable = `${currentTable}_license`;

        const mutatingActions = new Set([
          "create_license", "update_license", "delete_license",
          "create_gift_key", "update_gift_key", "delete_gift_key",
          "add_rom", "delete_rom", "bulk_delete_roms",
          "bulk_delete_licenses", "bulk_update_licenses", "bulk_import_licenses",
          "bulk_delete_gift_keys", "bulk_update_gift_keys",
          "bulk_import_roms",
          "update_setting_auto_email",
          "create_license_table", "rename_license_table", "delete_license_table"
        ]);
        if (mutatingActions.has(action)) {
          ctx.waitUntil(bumpDbVersion(env));
        }

        // =====================================================================
        // THAO TÁC QUẢN LÝ BẢNG BẢN QUYỀN
        // =====================================================================
        if (action === "create_license_table") {
          const rawName = body.name;
          const shortName = sanitizeLicenseName(rawName);
          if (!shortName) {
            return jsonResponse({ success: false, error: "Tên bảng không hợp lệ! Chỉ dùng chữ cái, số, gạch nối (-) hoặc gạch dưới (_)." }, 400);
          }

          await ensureDbSchema(env);
          const newActual = `${shortName}_license`;

          // Kiểm tra xem bảng đã tồn tại chưa
          const regExists = await env.DB.prepare("SELECT table_name FROM license_registries WHERE table_name = ?").bind(shortName).first();
          if (regExists) {
            return jsonResponse({ success: false, error: `Bảng bản quyền "${shortName}" đã tồn tại trong hệ thống!` }, 400);
          }

          // Tạo bảng trong D1
          await env.DB.prepare(`
            CREATE TABLE IF NOT EXISTS "${newActual}" (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              serial TEXT NOT NULL,
              rom_version TEXT NOT NULL,
              key_status TEXT DEFAULT 'OK',
              email_phone TEXT,
              country TEXT DEFAULT 'VN',
              gmail_notify TEXT DEFAULT 'NONE',
              note TEXT,
              created_at INTEGER,
              prefix TEXT
            )
          `).run();
          await env.DB.prepare(`CREATE INDEX IF NOT EXISTS "idx_${shortName}_prefix" ON "${newActual}"(prefix)`).run();
          await env.DB.prepare(`CREATE INDEX IF NOT EXISTS "idx_${shortName}_serial_rom" ON "${newActual}"(serial, rom_version)`).run();

          // Thêm vào danh bạ registries
          await env.DB.prepare("INSERT INTO license_registries (table_name, display_name, created_at) VALUES (?, ?, ?)").bind(shortName, shortName, Date.now()).run();

          return jsonResponse({
            success: true,
            table_name: shortName,
            actual_table: newActual,
            message: `Đã tạo bảng bản quyền "${newActual}" thành công!`
          });
        }
        else if (action === "rename_license_table") {
          const oldShort = sanitizeLicenseName(body.old_name);
          const newShort = sanitizeLicenseName(body.new_name);
          if (!oldShort || !newShort) {
            return jsonResponse({ success: false, error: "Tên bảng cũ hoặc mới không hợp lệ!" }, 400);
          }
          if (oldShort === newShort) {
            return jsonResponse({ success: true, message: "Tên bảng không đổi." });
          }

          await ensureDbSchema(env);
          const oldActual = `${oldShort}_license`;
          const newActual = `${newShort}_license`;

          const checkExists = await env.DB.prepare("SELECT table_name FROM license_registries WHERE table_name = ?").bind(newShort).first();
          if (checkExists) {
            return jsonResponse({ success: false, error: `Tên bảng "${newShort}" đã tồn tại!` }, 400);
          }

          // 1. Đổi tên bảng trong D1
          await env.DB.prepare(`ALTER TABLE "${oldActual}" RENAME TO "${newActual}"`).run();

          // 2. Cập nhật dữ liệu liên kết trong product_categories và gift_keys
          await env.DB.prepare("UPDATE product_categories SET license_table = ? WHERE license_table = ?").bind(newShort, oldShort).run();
          await env.DB.prepare("UPDATE gift_keys SET license_table = ? WHERE license_table = ?").bind(newShort, oldShort).run();
          await env.DB.prepare("UPDATE license_registries SET table_name = ?, display_name = ? WHERE table_name = ?").bind(newShort, newShort, oldShort).run();

          // 3. Đổi tên thư mục tương ứng trên GitHub (json/<oldShort>/ -> json/<newShort>/)
          const gitRes = await renameGitHubFolder(env, oldShort, newShort);

          return jsonResponse({
            success: true,
            old_name: oldShort,
            new_name: newShort,
            github_result: gitRes,
            message: `Đã đổi tên bảng thành "${newActual}" và cập nhật thư mục GitHub!`
          });
        }
        else if (action === "delete_license_table") {
          const targetShort = sanitizeLicenseName(body.name || body.table_name || currentTable);
          if (!targetShort) {
            return jsonResponse({ success: false, error: "Tên bảng cần xóa không hợp lệ!" }, 400);
          }

          await ensureDbSchema(env);
          const delActual = `${targetShort}_license`;

          // Bắt buộc kiểm tra dữ liệu trong bảng: chỉ xóa khi bảng trống
          let rowCount = 0;
          try {
            const countRow = await env.DB.prepare(`SELECT COUNT(*) as cnt FROM "${delActual}"`).first();
            rowCount = countRow ? (countRow.cnt || 0) : 0;
          } catch (_) { }

          if (rowCount > 0) {
            return jsonResponse({
              success: false,
              error: `Bảng "${delActual}" còn chứa ${rowCount} thiết bị bản quyền, không thể xóa! Vui lòng xóa hết bản quyền trong bảng trước khi xóa bảng.`
            }, 400);
          }

          // Xóa bảng D1
          try {
            await env.DB.prepare(`DROP TABLE IF EXISTS "${delActual}"`).run();
          } catch (dropErr) {
            console.error("Lỗi xóa bảng D1:", dropErr);
          }

          // Tự động xóa dữ liệu liên kết của bảng này trong các bảng dùng chung
          await env.DB.prepare("DELETE FROM product_categories WHERE license_table = ?").bind(targetShort).run();
          await env.DB.prepare("DELETE FROM gift_keys WHERE license_table = ?").bind(targetShort).run();
          await env.DB.prepare("DELETE FROM license_registries WHERE table_name = ?").bind(targetShort).run();

          return jsonResponse({
            success: true,
            table_name: targetShort,
            message: `Đã xóa bảng "${delActual}" và làm sạch các dữ liệu liên kết thành công!`
          });
        }

        // =====================================================================
        // THAO TÁC BẢN QUYỀN (LICENSES)
        // =====================================================================
        else if (action === "create_license") {
          const { rom_version, key_status, email_phone, country, note } = body;
          const serial = sanitizeCode(body.serial);
          if (!serial) {
            return jsonResponse({ success: false, error: "Serial không hợp lệ" }, 400);
          }

          await ensureDbSchema(env);
          const existing = await env.DB.prepare(
            `SELECT id FROM "${actualTable}" WHERE serial = ? AND rom_version = ?`
          ).bind(serial, rom_version).first();

          if (existing) {
            return jsonResponse({
              success: false,
              error: `Thiết bị có Serial "${serial}" và Sản phẩm "${rom_version}" đã tồn tại trong bảng ${currentTable}!`
            }, 400);
          }

          const prefix = getDevicePrefix(serial);
          const now = Date.now();
          const insertRes = await env.DB.prepare(
            `INSERT INTO "${actualTable}" (serial, rom_version, key_status, email_phone, country, gmail_notify, note, created_at, prefix)
           VALUES (?, ?, ?, ?, ?, 'NONE', ?, ?, ?)`
          ).bind(serial, rom_version, key_status || 'OK', email_phone || '', country || 'VN', note || '', now, prefix).run();

          const newId = insertRes.meta?.last_row_id;
          const gasUrl = env.GAS_WEBAPP_URL;
          const secret = env.INTERNAL_SECRET;

          // KIỂM TRA ĐIỀU KIỆN TỰ ĐỘNG GỬI EMAIL SAU 60 GIÂY
          if (newId) {
            const autoEmailSetting = await env.DB.prepare("SELECT req_count FROM system_stats WHERE date_key = 'SETTINGS' AND service_type = 'AUTO_SEND_EMAIL'").first();
            const isAutoEmailEnabled = autoEmailSetting ? autoEmailSetting.req_count === 1 : false;

            const hasEmail = email_phone && email_phone.includes("@");
            const isSerialNotEmpty = serial && serial.trim() !== "";
            const isRomNotEmpty = rom_version && rom_version.trim() !== "";
            const isKeyOk = (key_status || 'OK') === 'OK';

            if (isAutoEmailEnabled && hasEmail && isSerialNotEmpty && isRomNotEmpty && isKeyOk) {
              ctx.waitUntil((async () => {
                try {
                  await new Promise(resolve => setTimeout(resolve, 60000));

                  const lockRes = await env.DB.prepare(
                    `UPDATE "${actualTable}" SET gmail_notify = 'SENDING' WHERE id = ? AND gmail_notify = 'NONE' AND key_status = 'OK'`
                  ).bind(newId).run();

                  if (!lockRes.meta || lockRes.meta.changes === 0) return;

                  const item = await env.DB.prepare(`SELECT * FROM "${actualTable}" WHERE id = ?`).bind(newId).first();
                  if (!item || !item.email_phone || !item.email_phone.includes("@")) {
                    await env.DB.prepare(`UPDATE "${actualTable}" SET gmail_notify = 'ERROR' WHERE id = ?`).bind(newId).run();
                    return;
                  }
                  const gasRes = await fetch(gasUrl, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    redirect: "follow",
                    body: JSON.stringify({
                      secret: secret,
                      email: item.email_phone,
                      serial: item.serial,
                      rom_version: item.rom_version,
                      country: item.country
                    })
                  });
                  const gasText = await gasRes.text();
                  let gasJson = {};
                  try { gasJson = JSON.parse(gasText); } catch (_) { }

                  if (gasJson.success) {
                    await env.DB.prepare(`UPDATE "${actualTable}" SET gmail_notify = 'OK' WHERE id = ?`).bind(newId).run();
                  } else {
                    await env.DB.prepare(`UPDATE "${actualTable}" SET gmail_notify = 'ERROR' WHERE id = ?`).bind(newId).run();
                  }
                  await bumpDbVersion(env);
                } catch (err) {
                  console.error("Lỗi gửi email tự động 60s:", err);
                  try {
                    await env.DB.prepare(`UPDATE "${actualTable}" SET gmail_notify = 'ERROR' WHERE id = ?`).bind(newId).run();
                    await bumpDbVersion(env);
                  } catch (_) { }
                }
              })());
            }
          }

          // Tự động đẩy file phân mảnh lên GitHub Repo cho Cloudflare Pages (dùng block commit)
          const gitRes = await syncShardsBlockToGitHub(env, [prefix], `Add license ${serial}`, currentTable);
          if (!gitRes.success) {
            return jsonResponse({
              success: false,
              error: `Đã thêm vào CSDL nhưng lỗi đồng bộ GitHub: ${gitRes.error}`
            }, 500);
          }

          return jsonResponse({
            success: true,
            message: `Đã thêm thành công và đồng bộ shard json/${currentTable}/${prefix}.json lên GitHub!`,
            prefix,
            id: newId
          });
        }
        else if (action === "update_license") {
          const { id, rom_version, key_status, email_phone, country, note } = body;
          const serial = sanitizeCode(body.serial);
          if (!serial) {
            return jsonResponse({ success: false, error: "Serial không hợp lệ" }, 400);
          }

          await ensureDbSchema(env);
          const duplicate = await env.DB.prepare(
            `SELECT id FROM "${actualTable}" WHERE serial = ? AND rom_version = ? AND id != ?`
          ).bind(serial, rom_version, id).first();

          if (duplicate) {
            return jsonResponse({
              success: false,
              error: `Không thể lưu! Serial "${serial}" và Sản phẩm "${rom_version}" đã thuộc về mục khác.`
            }, 400);
          }

          const oldItem = await env.DB.prepare(`SELECT serial, prefix FROM "${actualTable}" WHERE id = ?`).bind(id).first();
          const oldPrefix = oldItem?.prefix || (oldItem ? getDevicePrefix(oldItem.serial) : null);
          const newPrefix = getDevicePrefix(serial);

          await env.DB.prepare(
            `UPDATE "${actualTable}" SET serial = ?, rom_version = ?, key_status = ?, email_phone = ?, country = ?, note = ?, prefix = ?
           WHERE id = ?`
          ).bind(serial, rom_version, key_status, email_phone || '', country, note || '', newPrefix, id).run();

          // Đồng bộ block lên GitHub
          const prefixesToSync = Array.from(new Set([oldPrefix, newPrefix].filter(Boolean)));
          const gitRes = await syncShardsBlockToGitHub(env, prefixesToSync, `Update license ${serial}`, currentTable);
          if (!gitRes.success) {
            return jsonResponse({
              success: false,
              error: `Đã cập nhật CSDL nhưng lỗi đồng bộ GitHub: ${gitRes.error}`
            }, 500);
          }

          return jsonResponse({
            success: true,
            message: `Đã cập nhật thành công và đồng bộ ${prefixesToSync.length} shard lên GitHub!`,
            prefix: newPrefix
          });
        }
        else if (action === "delete_license") {
          await ensureDbSchema(env);
          const oldItem = await env.DB.prepare(`SELECT serial, prefix FROM "${actualTable}" WHERE id = ?`).bind(body.id).first();
          const prefix = oldItem?.prefix || (oldItem ? getDevicePrefix(oldItem.serial) : null);

          await env.DB.prepare(`DELETE FROM "${actualTable}" WHERE id = ?`).bind(body.id).run();

          if (prefix) {
            const gitRes = await syncShardsBlockToGitHub(env, [prefix], `Delete license ${body.id}`, currentTable);
            if (!gitRes.success) {
              return jsonResponse({
                success: false,
                error: `Đã xóa trong CSDL nhưng lỗi đồng bộ GitHub: ${gitRes.error}`
              }, 500);
            }
          }
          return jsonResponse({ success: true, message: `Đã xóa kích hoạt thành công và cập nhật GitHub!` });
        }
        else if (action === "sync_single_shard") {
          const prefix = String(body.prefix ?? "").trim().toLowerCase();
          if (!prefix) {
            return jsonResponse({ success: false, error: "Thiếu prefix" }, 400);
          }
          await ensureDbSchema(env);
          const gitRes = await syncShardsBlockToGitHub(env, [prefix], `Sync shard json/${currentTable}/${prefix}.json`, currentTable);
          if (gitRes && gitRes.success) {
            return jsonResponse({
              success: true,
              prefix,
              count: gitRes.count,
              message: `Đã lưu json/${currentTable}/${prefix}.json lên GitHub thành công!`
            });
          } else {
            return jsonResponse({
              success: false,
              prefix,
              error: gitRes ? gitRes.error : "Không thể đồng bộ shard"
            }, 500);
          }
        }
        else if (action === "reindex_all_prefixes") {
          await ensureDbSchema(env);
          const { results } = await env.DB.prepare(`SELECT id, serial, rom_version, key_status FROM "${actualTable}"`).all();
          const records = results || [];
          const xorKey = env?.XOR_KEY;

          const prefixMap = new Map();
          const updateStmts = [];

          for (const row of records) {
            const p = getDevicePrefix(row.serial);
            updateStmts.push(env.DB.prepare(`UPDATE "${actualTable}" SET prefix = ? WHERE id = ?`).bind(p, row.id));

            if (!prefixMap.has(p)) prefixMap.set(p, []);
            const raw = `${row.serial}:${row.rom_version}:${row.key_status}`;
            prefixMap.get(p).push(xorEncryptHex(raw, xorKey));
          }

          await executeDbBatch(env.DB, updateStmts);

          const filesToCommit = [];
          for (const [p, encList] of prefixMap.entries()) {
            filesToCommit.push({
              path: `json/${currentTable}/${p}.json`,
              content: JSON.stringify(encList, null, 2)
            });
          }

          // Thêm cả json/<currentTable>/giftcode.json vào cùng 1 block commit duy nhất
          try {
            const today = new Date().toISOString().split("T")[0];
            const giftRes = await env.DB.prepare(
              "SELECT gift_code, start_date, expiration_date, extend FROM gift_keys WHERE license_table = ? AND expiration_date >= ? ORDER BY created_at DESC"
            ).bind(currentTable, today).all();
            const giftList = (giftRes?.results || []).map(r => {
              const extendVal = r.extend != null ? Number(r.extend) : 7;
              const rawMeta = `${r.start_date}:${r.expiration_date}:${extendVal}`;
              return {
                gift_code: r.gift_code,
                metadata: xorEncryptHex(rawMeta, xorKey)
              };
            });
            filesToCommit.push({
              path: `json/${currentTable}/giftcode.json`,
              content: JSON.stringify(giftList, null, 2)
            });
          } catch (_) { }

          const gitRes = await commitFilesToGitHubBlock(env, filesToCommit, `Đồng bộ toàn bộ ${filesToCommit.length} file Shard bảng ${currentTable} via MRD Admin`);
          if (!gitRes.success) {
            return jsonResponse({ success: false, error: gitRes.error }, 500);
          }

          return jsonResponse({
            success: true,
            totalFiles: filesToCommit.length,
            totalLicenses: records.length,
            message: `Đã đóng gói và đồng bộ thành công ${filesToCommit.length} file lên GitHub!`
          });
        }

        // =====================================================================
        // THAO TÁC GIFT CODE
        // =====================================================================
        else if (action === "create_gift_key") {
          let { start_date, expiration_date, note, extend } = body;
          const gift_code = sanitizeCode(body.gift_code);
          start_date = normalizeDateStr(start_date);
          expiration_date = normalizeDateStr(expiration_date);
          const extendDays = Number(extend) > 0 ? Number(extend) : 7;
          if (!gift_code || !start_date || !expiration_date) {
            return jsonResponse({ success: false, error: "Thiếu thông tin GIFT_CODE hoặc ngày hiệu lực" }, 400);
          }

          await ensureDbSchema(env);
          const existing = await env.DB.prepare(
            "SELECT id FROM gift_keys WHERE gift_code = ?"
          ).bind(gift_code).first();

          if (existing) {
            return jsonResponse({ success: false, error: `Gift code "${gift_code}" đã tồn tại trong hệ thống!` }, 400);
          }

          await env.DB.prepare(`
            INSERT INTO gift_keys (gift_code, start_date, expiration_date, extend, note, created_at, license_table)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `).bind(gift_code, start_date, expiration_date, extendDays, note || '', Date.now(), currentTable).run();

          const gitRes = await syncGiftCodeToGitHub(env, currentTable);
          if (!gitRes.success) {
            return jsonResponse({
              success: false,
              error: `Đã lưu CSDL nhưng lỗi đồng bộ GitHub: ${gitRes.error}`
            }, 500);
          }

          return jsonResponse({
            success: true,
            message: `Đã tạo Gift Code thành công và đồng bộ json/${currentTable}/giftcode.json lên GitHub!`
          });
        }
        else if (action === "update_gift_key") {
          let { id, start_date, expiration_date, note, extend } = body;
          const gift_code = sanitizeCode(body.gift_code);
          start_date = normalizeDateStr(start_date);
          expiration_date = normalizeDateStr(expiration_date);
          const extendDays = Number(extend) > 0 ? Number(extend) : 7;
          if (!id || !gift_code || !start_date || !expiration_date) {
            return jsonResponse({ success: false, error: "Thiếu dữ liệu cập nhật Gift Code" }, 400);
          }

          await ensureDbSchema(env);
          const duplicate = await env.DB.prepare(
            "SELECT id FROM gift_keys WHERE gift_code = ? AND id != ?"
          ).bind(gift_code, id).first();

          if (duplicate) {
            return jsonResponse({ success: false, error: `Gift code "${gift_code}" đã thuộc về mục khác!` }, 400);
          }

          await env.DB.prepare(`
            UPDATE gift_keys SET gift_code = ?, start_date = ?, expiration_date = ?, extend = ?, note = ?
            WHERE id = ?
          `).bind(gift_code, start_date, expiration_date, extendDays, note || '', id).run();

          const gitRes = await syncGiftCodeToGitHub(env, currentTable);
          if (!gitRes.success) {
            return jsonResponse({
              success: false,
              error: `Đã cập nhật CSDL nhưng lỗi đồng bộ GitHub: ${gitRes.error}`
            }, 500);
          }

          return jsonResponse({
            success: true,
            message: `Đã cập nhật Gift Code thành công và đồng bộ json/${currentTable}/giftcode.json lên GitHub!`
          });
        }
        else if (action === "delete_gift_key") {
          await ensureDbSchema(env);
          await env.DB.prepare("DELETE FROM gift_keys WHERE id = ?").bind(body.id).run();

          const gitRes = await syncGiftCodeToGitHub(env, currentTable);
          if (!gitRes.success) {
            return jsonResponse({
              success: false,
              error: `Đã xóa trong CSDL nhưng lỗi đồng bộ GitHub: ${gitRes.error}`
            }, 500);
          }

          return jsonResponse({
            success: true,
            message: `Đã xóa Gift Code thành công và cập nhật json/${currentTable}/giftcode.json lên GitHub!`
          });
        }
        else if (action === "sync_gift_code") {
          await ensureDbSchema(env);
          const gitRes = await syncGiftCodeToGitHub(env, currentTable);
          if (gitRes && gitRes.success) {
            return jsonResponse({ success: true, message: `Đã lưu json/${currentTable}/giftcode.json lên GitHub thành công!` });
          } else {
            return jsonResponse({ success: false, error: gitRes ? gitRes.error : "Lỗi không xác định" });
          }
        }

        // =====================================================================
        // THAO TÁC SẢN PHẨM (PRODUCT CATEGORIES)
        // =====================================================================
        else if (action === "add_rom" || action === "add_product_category") {
          const { name } = body;
          if (!name) return jsonResponse({ error: "Tên Sản phẩm không được để trống" }, 400);
          await ensureDbSchema(env);
          await env.DB.prepare("INSERT OR IGNORE INTO product_categories (name, license_table) VALUES (?, ?)").bind(name.trim(), currentTable).run();
          return jsonResponse({ success: true, message: `Đã thêm sản phẩm "${name}" thành công!` });
        }
        else if (action === "delete_rom" || action === "delete_product_category") {
          await ensureDbSchema(env);
          await env.DB.prepare("DELETE FROM product_categories WHERE name = ? AND license_table = ?").bind(body.name, currentTable).run();
          return jsonResponse({ success: true, message: `Đã xóa Sản phẩm "${body.name}" thành công!` });
        }
        else if (action === "bulk_delete_roms") {
          const { names } = body;
          if (!Array.isArray(names) || names.length === 0) {
            return jsonResponse({ success: false, error: "Danh sách sản phẩm không hợp lệ" }, 400);
          }
          await ensureDbSchema(env);
          const CHUNK_SIZE = 50;
          for (let i = 0; i < names.length; i += CHUNK_SIZE) {
            const chunk = names.slice(i, i + CHUNK_SIZE);
            const placeholders = chunk.map(() => "?").join(",");
            await env.DB.prepare(`DELETE FROM product_categories WHERE license_table = ? AND name IN (${placeholders})`).bind(currentTable, ...chunk).run();
          }
          return jsonResponse({ success: true, count: names.length, message: `Đã xóa thành công ${names.length} Sản phẩm!` });
        }
        else if (action === "bulk_delete_licenses") {
          const { ids } = body;
          if (!Array.isArray(ids) || ids.length === 0) {
            return jsonResponse({ success: false, error: "Danh sách ID không hợp lệ" }, 400);
          }
          await ensureDbSchema(env);

          const affectedPrefixes = new Set();
          const CHUNK_SIZE = 50;

          for (let i = 0; i < ids.length; i += CHUNK_SIZE) {
            const chunkIds = ids.slice(i, i + CHUNK_SIZE);
            const placeholders = chunkIds.map(() => "?").join(",");
            const oldItems = await env.DB.prepare(`SELECT serial, prefix FROM "${actualTable}" WHERE id IN (${placeholders})`).bind(...chunkIds).all();
            (oldItems.results || []).forEach(row => {
              const p = row.prefix || getDevicePrefix(row.serial);
              if (p) affectedPrefixes.add(p);
            });
            await env.DB.prepare(`DELETE FROM "${actualTable}" WHERE id IN (${placeholders})`).bind(...chunkIds).run();
          }

          const delPrefixesList = Array.from(affectedPrefixes).sort();
          const gitRes = await syncShardsBlockToGitHub(env, delPrefixesList, `Xóa ${ids.length} thiết bị (${delPrefixesList.length} shards)`, currentTable);

          if (!gitRes.success) {
            return jsonResponse({
              success: false,
              count: ids.length,
              error: `Đã xóa trong CSDL nhưng lỗi đồng bộ GitHub: ${gitRes.error}`
            }, 500);
          }

          return jsonResponse({
            success: true,
            count: ids.length,
            message: `Đã xóa thành công ${ids.length} mục và cập nhật ${delPrefixesList.length} shard lên GitHub!`
          });
        }
        else if (action === "bulk_update_licenses") {
          const { items } = body;
          if (!Array.isArray(items) || items.length === 0) {
            return jsonResponse({ success: false, error: "Danh sách cập nhật không hợp lệ" }, 400);
          }
          await ensureDbSchema(env);

          const affectedPrefixes = new Set();
          const stmts = [];

          for (const it of items) {
            if (!it.id || !it.serial || !it.rom_version) continue;
            const cleanSerial = sanitizeCode(it.serial);
            const newPrefix = getDevicePrefix(cleanSerial);
            affectedPrefixes.add(newPrefix);
            if (it.old_prefix) affectedPrefixes.add(it.old_prefix);

            stmts.push(
              env.DB.prepare(
                `UPDATE "${actualTable}" SET serial = ?, rom_version = ?, key_status = ?, email_phone = ?, country = ?, gmail_notify = ?, note = ?, prefix = ? WHERE id = ?`
              ).bind(
                cleanSerial,
                it.rom_version.trim(),
                it.key_status || 'OK',
                it.email_phone || '',
                it.country || 'VN',
                it.gmail_notify || 'NONE',
                it.note || '',
                newPrefix,
                it.id
              )
            );
          }

          await executeDbBatch(env.DB, stmts);

          const updatePrefixesList = Array.from(affectedPrefixes).sort();
          const gitRes = await syncShardsBlockToGitHub(env, updatePrefixesList, `Cập nhật ${stmts.length} thiết bị (${updatePrefixesList.length} shards)`, currentTable);

          if (!gitRes.success) {
            return jsonResponse({
              success: false,
              count: stmts.length,
              error: `Đã cập nhật CSDL nhưng lỗi đồng bộ GitHub: ${gitRes.error}`
            }, 500);
          }

          return jsonResponse({
            success: true,
            count: stmts.length,
            message: `Đã cập nhật thành công ${stmts.length} mục và đồng bộ ${updatePrefixesList.length} shard lên GitHub!`
          });
        }
        else if (action === "bulk_import_licenses") {
          const { items } = body;
          if (!Array.isArray(items) || items.length === 0) {
            return jsonResponse({ success: false, error: "Dữ liệu nhập không hợp lệ" }, 400);
          }
          await ensureDbSchema(env);

          const existingRes = await env.DB.prepare(`SELECT serial, rom_version FROM "${actualTable}"`).all();
          const existingSet = new Set((existingRes.results || []).map(r => `${(r.serial || '').trim()}_${(r.rom_version || '').trim()}`));

          const affectedPrefixes = new Set();
          const allUploadedPrefixes = new Set();
          const stmts = [];
          let skipped = 0;

          for (const it of items) {
            const s = (it.serial || '').trim();
            const r = (it.rom_version || '').trim();
            if (!s || !r) continue;

            const prefix = getDevicePrefix(s);
            allUploadedPrefixes.add(prefix);

            const keyPair = `${s}_${r}`;
            if (existingSet.has(keyPair)) {
              skipped++;
              continue;
            }
            existingSet.add(keyPair);
            affectedPrefixes.add(prefix);

            stmts.push(
              env.DB.prepare(
                `INSERT INTO "${actualTable}" (serial, rom_version, key_status, email_phone, country, gmail_notify, note, created_at, prefix)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
              ).bind(
                s,
                r,
                it.key_status || 'OK',
                it.email_phone || '',
                it.country || 'VN',
                it.gmail_notify || 'NONE',
                it.note || '',
                Date.now(),
                prefix
              )
            );
          }

          await executeDbBatch(env.DB, stmts);

          const prefixesToSync = (affectedPrefixes.size > 0 ? Array.from(affectedPrefixes) : Array.from(allUploadedPrefixes)).sort();
          const gitRes = await syncShardsBlockToGitHub(env, prefixesToSync, `Nhập ${stmts.length} thiết bị từ Excel (${prefixesToSync.length} shards)`, currentTable);

          if (!gitRes.success) {
            return jsonResponse({
              success: false,
              imported: stmts.length,
              skipped,
              error: `Đã nhập CSDL (${stmts.length} mục) nhưng lỗi đồng bộ GitHub: ${gitRes.error}`
            }, 500);
          }

          return jsonResponse({
            success: true,
            imported: stmts.length,
            skipped,
            shardsCount: prefixesToSync.length,
            message: `Đã nhập thành công ${stmts.length} mục và đồng bộ ${prefixesToSync.length} shard lên GitHub!`
          });
        }
        else if (action === "bulk_delete_gift_keys") {
          const { ids } = body;
          if (!Array.isArray(ids) || ids.length === 0) {
            return jsonResponse({ success: false, error: "Danh sách ID không hợp lệ" }, 400);
          }
          await ensureDbSchema(env);
          const CHUNK_SIZE = 50;
          for (let i = 0; i < ids.length; i += CHUNK_SIZE) {
            const chunk = ids.slice(i, i + CHUNK_SIZE);
            const placeholders = chunk.map(() => "?").join(",");
            await env.DB.prepare(`DELETE FROM gift_keys WHERE id IN (${placeholders})`).bind(...chunk).run();
          }

          const gitRes = await syncGiftCodeToGitHub(env, currentTable);
          if (!gitRes.success) {
            return jsonResponse({
              success: false,
              error: `Đã xóa trong CSDL nhưng lỗi đồng bộ GitHub: ${gitRes.error}`
            }, 500);
          }

          return jsonResponse({ success: true, count: ids.length, message: `Đã xóa thành công ${ids.length} Gift Code và cập nhật GitHub!` });
        }
        else if (action === "bulk_update_gift_keys") {
          const { items } = body;
          if (!Array.isArray(items) || items.length === 0) {
            return jsonResponse({ success: false, error: "Dữ liệu cập nhật không hợp lệ" }, 400);
          }
          await ensureDbSchema(env);
          const stmts = [];
          for (const it of items) {
            const sDate = normalizeDateStr(it.start_date);
            const eDate = normalizeDateStr(it.expiration_date);
            if (!it.id || !it.gift_code || !sDate || !eDate) continue;
            const cleanGift = sanitizeCode(it.gift_code);
            const extendDays = Number(it.extend) > 0 ? Number(it.extend) : 7;
            stmts.push(
              env.DB.prepare(
                `UPDATE gift_keys SET gift_code = ?, start_date = ?, expiration_date = ?, extend = ?, note = ? WHERE id = ?`
              ).bind(cleanGift, sDate, eDate, extendDays, (it.note || '').trim(), Number(it.id))
            );
          }
          await executeDbBatch(env.DB, stmts);
          const gitRes = await syncGiftCodeToGitHub(env, currentTable);
          if (!gitRes.success) {
            return jsonResponse({
              success: false,
              error: `Đã cập nhật CSDL nhưng lỗi đồng bộ GitHub: ${gitRes.error}`
            }, 500);
          }

          return jsonResponse({ success: true, count: stmts.length, message: `Đã cập nhật ${stmts.length} Gift Code và đồng bộ GitHub!` });
        }
        else if (action === "bulk_import_roms") {
          const { names } = body;
          if (!Array.isArray(names) || names.length === 0) {
            return jsonResponse({ success: false, error: "Danh sách sản phẩm không hợp lệ" }, 400);
          }
          await ensureDbSchema(env);
          const stmts = [];
          const uniqueNames = new Set(names.map(n => String(n).trim()).filter(Boolean));
          for (const name of uniqueNames) {
            stmts.push(env.DB.prepare("INSERT OR IGNORE INTO product_categories (name, license_table) VALUES (?, ?)").bind(name, currentTable));
          }
          await executeDbBatch(env.DB, stmts);
          return jsonResponse({ success: true, count: stmts.length, message: `Đã thêm thành công ${stmts.length} sản phẩm!` });
        }
        else if (action === "update_setting_auto_email") {
          const isEnabled = body.enabled ? 1 : 0;
          await env.DB.prepare(`
          INSERT INTO system_stats (date_key, service_type, req_count)
          VALUES ('SETTINGS', 'AUTO_SEND_EMAIL', ?)
          ON CONFLICT(date_key, service_type) DO UPDATE SET req_count = ?
        `).bind(isEnabled, isEnabled).run();
          return jsonResponse({ success: true, enabled: isEnabled === 1 });
        }
        else if (action === "resend_mail") {
          const isAuto = !!body.is_auto;

          if (isAuto) {
            const lockRes = await env.DB.prepare(
              `UPDATE "${actualTable}" SET gmail_notify = 'SENDING' WHERE id = ? AND gmail_notify = 'NONE' AND key_status = 'OK'`
            ).bind(body.id).run();

            if (!lockRes.meta || lockRes.meta.changes === 0) {
              const currentItem = await env.DB.prepare(`SELECT gmail_notify FROM "${actualTable}" WHERE id = ?`).bind(body.id).first();
              return jsonResponse({
                success: true,
                already_handled: true,
                gmail_notify: currentItem ? (currentItem.gmail_notify === "SENT" ? "OK" : currentItem.gmail_notify) : "OK"
              });
            }
          }

          const item = await env.DB.prepare(`SELECT * FROM "${actualTable}" WHERE id = ?`).bind(body.id).first();
          if (!item || !item.email_phone || !item.email_phone.includes("@")) {
            if (isAuto) {
              await env.DB.prepare(`UPDATE "${actualTable}" SET gmail_notify = 'ERROR' WHERE id = ?`).bind(body.id).run();
            }
            return jsonResponse({ success: false, error: "Email không hợp lệ" }, 400);
          }

          const gasUrl = env.GAS_WEBAPP_URL;
          const secret = env.INTERNAL_SECRET;

          try {
            const gasRes = await fetch(gasUrl, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              redirect: "follow",
              body: JSON.stringify({
                secret: secret,
                email: item.email_phone,
                serial: item.serial,
                rom_version: item.rom_version,
                country: item.country
              })
            });

            const gasText = await gasRes.text();
            let gasJson = {};
            try { gasJson = JSON.parse(gasText); } catch (err) { }

            if (gasJson.success) {
              await env.DB.prepare(`UPDATE "${actualTable}" SET gmail_notify = 'OK' WHERE id = ?`).bind(item.id).run();
              await bumpDbVersion(env);
              return jsonResponse({ success: true, ref_id: gasJson.ref_id });
            } else {
              await env.DB.prepare(`UPDATE "${actualTable}" SET gmail_notify = 'ERROR' WHERE id = ?`).bind(item.id).run();
              await bumpDbVersion(env);
              return jsonResponse({ success: false, error: gasJson.error || gasText });
            }
          } catch (callErr) {
            await env.DB.prepare(`UPDATE "${actualTable}" SET gmail_notify = 'ERROR' WHERE id = ?`).bind(item.id).run();
            await bumpDbVersion(env);
            return jsonResponse({ success: false, error: "Không kết nối được tới Google Apps Script: " + callErr.message }, 500);
          }
        }

        return jsonResponse({ success: true });
      } catch (actErr) {
        console.error("Lỗi API Admin Action:", actErr);
        return jsonResponse({
          success: false,
          error: "Lỗi xử lý máy chủ: " + (actErr.message || String(actErr))
        }, 500);
      }
    }

    // =========================================================================
    // 4. GIAO DIỆN TĨNH & TÀI NGUYÊN CLOUDFLARE PAGES (ASSETS)
    // =========================================================================
    if (url.pathname === "/favicon.ico" || url.pathname === "/apple-touch-icon.png" || url.pathname === "/apple-touch-icon-precomposed.png") {
      if (env.ASSETS) return env.ASSETS.fetch(new Request(new URL("/icon-192.png", request.url), request));
    }

    if (url.pathname === "/admin" || url.pathname === "/admin/") {
      if (env.ASSETS) return env.ASSETS.fetch(new Request(new URL("/", request.url), request));
      return Response.redirect(new URL("/", request.url).toString(), 302);
    }

    if (env.ASSETS) {
      const res = await env.ASSETS.fetch(request);
      if (url.pathname === "/manifest.webmanifest" || url.pathname === "/manifest.json") {
        const h = new Headers(res.headers);
        h.set("Content-Type", "application/manifest+json; charset=utf-8");
        h.set("Cache-Control", "no-cache, no-store, must-revalidate");
        return new Response(res.body, { status: res.status, headers: h });
      }
      if (url.pathname.endsWith(".png") || url.pathname.endsWith(".svg")) {
        const h = new Headers(res.headers);
        h.set("Cache-Control", "no-cache, must-revalidate");
        return new Response(res.body, { status: res.status, headers: h });
      }
      return res;
    }

    return new Response("Not Found", { status: 404 });
  }
};

let schemaChecked = false;

/**
 * Tạo HMAC Session Token an toàn (hạn dùng 7 ngày) từ ADMIN_PASSWORD
 * Không bao giờ lưu mật khẩu thực trên trình duyệt, chống đọc trộm
 */
async function generateSessionToken(secret) {
  if (!secret) return "";
  const ts = Date.now().toString();
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode("MRD_ADMIN_SESSION:" + ts));
  const hexSig = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, "0")).join("");
  return `${ts}.${hexSig}`;
}

/**
 * Xác thực HMAC Session Token
 */
async function verifySessionToken(token, secret, maxAgeMs = 7 * 24 * 60 * 60 * 1000) {
  if (!token || !secret || typeof token !== "string" || !token.includes(".")) return false;
  const [ts, hexSig] = token.split(".");
  const timestamp = Number(ts);
  if (!timestamp || isNaN(timestamp)) return false;
  if (Date.now() - timestamp > maxAgeMs || timestamp > Date.now() + 60000) return false;

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const expectedSig = await crypto.subtle.sign("HMAC", key, enc.encode("MRD_ADMIN_SESSION:" + ts));
  const expectedHex = Array.from(new Uint8Array(expectedSig)).map(b => b.toString(16).padStart(2, "0")).join("");
  return hexSig === expectedHex;
}

/**
 * Cập nhật timestamp phiên bản cơ sở dữ liệu khi có thay đổi (dùng để đồng bộ đa thiết bị)
 */
async function bumpDbVersion(env) {
  if (!env?.DB) return;
  const now = Date.now();
  try {
    await env.DB.prepare(`
      INSERT INTO system_stats (date_key, service_type, req_count)
      VALUES ('SYSTEM', 'DB_VERSION', ?)
      ON CONFLICT(date_key, service_type) DO UPDATE SET req_count = ?
    `).bind(now, now).run();
  } catch (e) {
    console.error("Lỗi bumpDbVersion:", e);
  }
}

async function executeDbBatch(db, stmts, chunkSize = 100) {
  if (!db || !stmts || stmts.length === 0) return;
  for (let i = 0; i < stmts.length; i += chunkSize) {
    await db.batch(stmts.slice(i, i + chunkSize));
  }
}

function sanitizeLicenseName(name) {
  if (!name) return "";
  let clean = String(name).trim().replace(/[^a-zA-Z0-9_\-]/g, "");
  if (clean.toLowerCase().endsWith("_license")) {
    clean = clean.slice(0, -8);
  }
  return clean;
}

function getActualTableName(shortName) {
  const clean = sanitizeLicenseName(shortName) || "androidtv-x86";
  return `${clean}_license`;
}

async function ensureDbSchema(env) {
  if (schemaChecked || !env?.DB) return;

  try {
    // 1. Kiểm tra migration licenses -> androidtv-x86_license
    const checkLicenses = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='licenses'").first();
    const checkNewLic = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='androidtv-x86_license'").first();
    if (checkLicenses && !checkNewLic) {
      try {
        await env.DB.prepare('ALTER TABLE licenses RENAME TO "androidtv-x86_license"').run();
      } catch (mErr) {
        console.error("Lỗi đổi tên licenses:", mErr);
      }
    }

    // Đảm bảo bảng androidtv-x86_license tồn tại
    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS "androidtv-x86_license" (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        serial TEXT NOT NULL,
        rom_version TEXT NOT NULL,
        key_status TEXT DEFAULT 'OK',
        email_phone TEXT,
        country TEXT DEFAULT 'VN',
        gmail_notify TEXT DEFAULT 'NONE',
        note TEXT,
        created_at INTEGER,
        prefix TEXT
      )
    `).run();
    await env.DB.prepare(`CREATE INDEX IF NOT EXISTS "idx_androidtv-x86_prefix" ON "androidtv-x86_license"(prefix)`).run();
    await env.DB.prepare(`CREATE INDEX IF NOT EXISTS "idx_androidtv-x86_serial_rom" ON "androidtv-x86_license"(serial, rom_version)`).run();
  } catch (e) {
    // Bỏ qua lỗi
  }

  // Đảm bảo các cột mới luôn tồn tại trên androidtv-x86_license
  try { await env.DB.prepare(`ALTER TABLE "androidtv-x86_license" ADD COLUMN prefix TEXT`).run(); } catch (_) { }
  try { await env.DB.prepare(`ALTER TABLE "androidtv-x86_license" ADD COLUMN note TEXT`).run(); } catch (_) { }
  try { await env.DB.prepare(`ALTER TABLE "androidtv-x86_license" ADD COLUMN gmail_notify TEXT DEFAULT 'NONE'`).run(); } catch (_) { }
  try { await env.DB.prepare(`ALTER TABLE "androidtv-x86_license" ADD COLUMN created_at INTEGER`).run(); } catch (_) { }

  // 2. Kiểm tra migration rom_categories -> product_categories
  try {
    const checkRom = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='rom_categories'").first();
    const checkProd = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='product_categories'").first();
    if (checkRom && !checkProd) {
      try {
        await env.DB.prepare("ALTER TABLE rom_categories RENAME TO product_categories").run();
      } catch (mErr) {
        console.error("Lỗi đổi tên rom_categories:", mErr);
      }
    }

    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS product_categories (
        name TEXT,
        license_table TEXT DEFAULT 'androidtv-x86',
        PRIMARY KEY (name, license_table)
      )
    `).run();
  } catch (e) { }

  try { await env.DB.prepare("ALTER TABLE product_categories ADD COLUMN license_table TEXT DEFAULT 'androidtv-x86'").run(); } catch (_) { }
  try { await env.DB.prepare("UPDATE product_categories SET license_table = 'androidtv-x86' WHERE license_table IS NULL OR license_table = ''").run(); } catch (_) { }

  // 3. Đảm bảo bảng gift_keys có cột license_table
  try {
    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS gift_keys (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        gift_code TEXT UNIQUE NOT NULL,
        start_date TEXT NOT NULL,
        expiration_date TEXT NOT NULL,
        extend INTEGER DEFAULT 7,
        note TEXT,
        created_at INTEGER,
        license_table TEXT DEFAULT 'androidtv-x86'
      )
    `).run();
    await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_gift_keys_code ON gift_keys(gift_code)").run();
  } catch (e) { }

  try { await env.DB.prepare("ALTER TABLE gift_keys ADD COLUMN extend INTEGER DEFAULT 7").run(); } catch (_) { }
  try { await env.DB.prepare("ALTER TABLE gift_keys ADD COLUMN license_table TEXT DEFAULT 'androidtv-x86'").run(); } catch (_) { }
  try { await env.DB.prepare("UPDATE gift_keys SET license_table = 'androidtv-x86' WHERE license_table IS NULL OR license_table = ''").run(); } catch (_) { }

  // 4. Bảng danh bạ các bảng bản quyền license_registries
  try {
    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS license_registries (
        table_name TEXT PRIMARY KEY,
        display_name TEXT,
        created_at INTEGER
      )
    `).run();
    await env.DB.prepare("INSERT OR IGNORE INTO license_registries (table_name, display_name, created_at) VALUES ('androidtv-x86', 'androidtv-x86', ?)").bind(Date.now()).run();

    // Tự động quét và đăng ký tất cả các bảng *_license hiện có trong D1
    const allLicTables = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%_license'").all();
    for (const row of (allLicTables.results || [])) {
      const sName = sanitizeLicenseName(row.name);
      if (sName) {
        await env.DB.prepare("INSERT OR IGNORE INTO license_registries (table_name, display_name, created_at) VALUES (?, ?, ?)").bind(sName, sName, Date.now()).run();
      }
    }
  } catch (e) { }

  // 5. Bảng system_stats
  try {
    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS system_stats (
        date_key TEXT,
        service_type TEXT,
        req_count INTEGER DEFAULT 0,
        PRIMARY KEY (date_key, service_type)
      )
    `).run();
  } catch (e) { }

  schemaChecked = true;
}

/**
 * Đóng gói toàn bộ các file thành 1 Block duy nhất và commit lên GitHub qua Git Data Tree API
 * Cơ chế thử lại: Tự động thử lại 2 lần (tổng 3 lần) nếu GitHub trả về lỗi.
 */
async function commitFilesToGitHubBlock(env, filesArray, commitMessage) {
  if (!filesArray || filesArray.length === 0) {
    return { success: true, count: 0, message: "Không có file nào cần commit" };
  }

  const token = env?.GITHUB_TOKEN ? String(env.GITHUB_TOKEN).trim() : null;
  const rawRepo = env?.GITHUB_REPO ? String(env.GITHUB_REPO).trim() : null;
  const branch = env?.GITHUB_BRANCH ? String(env.GITHUB_BRANCH).trim() : "main";

  if (!token) {
    return { success: false, error: "Chưa cấu hình biến GITHUB_TOKEN trong Settings -> Environment variables của Pages" };
  }
  if (!rawRepo) {
    return { success: false, error: "Chưa cấu hình biến GITHUB_REPO trong Settings -> Environment variables của Pages" };
  }

  const cleanRepo = rawRepo
    .replace(/^https?:\/\/github\.com\//i, "")
    .replace(/^\/+|\/+$/g, "");

  const headers = {
    "Authorization": `Bearer ${token}`,
    "Accept": "application/vnd.github+json",
    "User-Agent": "MRD-Cloudflare-Pages"
  };

  const MAX_ATTEMPTS = 3; // Lần 1 + thử lại 2 lần
  let lastError = "";

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      // 1. Lấy SHA commit mới nhất và Base Tree SHA của nhánh
      const branchRes = await fetch(`https://api.github.com/repos/${cleanRepo}/branches/${branch}`, { headers });
      if (!branchRes.ok) {
        const txt = await branchRes.text();
        throw new Error(`Lấy branch ${branch} thất bại (HTTP ${branchRes.status}): ${txt}`);
      }
      const branchData = await branchRes.json();
      const latestCommitSha = branchData.commit.sha;
      const baseTreeSha = branchData.commit.commit.tree.sha;

      // 2. Tạo Git Tree chứa block tất cả các file cần cập nhật/xóa
      const treeItems = filesArray.map(f => {
        const item = {
          path: f.path,
          mode: "100644",
          type: "blob"
        };
        if (f.content !== undefined) item.content = f.content;
        if (f.sha !== undefined) item.sha = f.sha;
        return item;
      });

      const treeRes = await fetch(`https://api.github.com/repos/${cleanRepo}/git/trees`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({
          base_tree: baseTreeSha,
          tree: treeItems
        })
      });

      if (!treeRes.ok) {
        const txt = await treeRes.text();
        throw new Error(`Tạo Git Tree thất bại (HTTP ${treeRes.status}): ${txt}`);
      }
      const treeData = await treeRes.json();
      const newTreeSha = treeData.sha;

      // Tự động gắn [skip ci] vào tất cả các commit dữ liệu để Cloudflare Pages KHÔNG kích hoạt build & deploy
      let finalMessage = (commitMessage || `Sync ${filesArray.length} files via MRD License Admin`).trim();
      if (!finalMessage.includes("[skip ci]") && !finalMessage.includes("[ci skip]")) {
        finalMessage += " [skip ci]";
      }

      // 3. Tạo Commit duy nhất đại diện cho toàn bộ block file
      const commitRes = await fetch(`https://api.github.com/repos/${cleanRepo}/git/commits`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({
          message: finalMessage,
          tree: newTreeSha,
          parents: [latestCommitSha]
        })
      });

      if (!commitRes.ok) {
        const txt = await commitRes.text();
        throw new Error(`Tạo Git Commit thất bại (HTTP ${commitRes.status}): ${txt}`);
      }
      const commitData = await commitRes.json();
      const newCommitSha = commitData.sha;

      // 4. Cập nhật con trỏ branch trỏ tới commit mới
      const refRes = await fetch(`https://api.github.com/repos/${cleanRepo}/git/refs/heads/${branch}`, {
        method: "PATCH",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({
          sha: newCommitSha,
          force: false
        })
      });

      if (!refRes.ok) {
        const txt = await refRes.text();
        throw new Error(`Cập nhật nhánh ${branch} thất bại (HTTP ${refRes.status}): ${txt}`);
      }

      // Hoàn thành xuất sắc trong attempt này
      return {
        success: true,
        count: filesArray.length,
        commitSha: newCommitSha,
        attempt,
        message: `Đã đồng bộ thành công ${filesArray.length} file lên GitHub (Commit: ${newCommitSha.substring(0, 7)})!`
      };
    } catch (err) {
      lastError = err.message;
      console.warn(`Lần thử ${attempt}/${MAX_ATTEMPTS} đồng bộ GitHub thất bại:`, lastError);

      if (attempt < MAX_ATTEMPTS) {
        await new Promise(r => setTimeout(r, 1500));
      }
    }
  }

  return {
    success: false,
    count: filesArray.length,
    error: `Đã thử lại 2 lần (tổng 3 lần) nhưng GitHub vẫn báo lỗi: ${lastError}`
  };
}

/**
 * Đổi tên thư mục json/<oldFolder> sang json/<newFolder> trên GitHub
 */
async function renameGitHubFolder(env, oldFolder, newFolder) {
  const token = env?.GITHUB_TOKEN ? String(env.GITHUB_TOKEN).trim() : null;
  const rawRepo = env?.GITHUB_REPO ? String(env.GITHUB_REPO).trim() : null;
  const branch = env?.GITHUB_BRANCH ? String(env.GITHUB_BRANCH).trim() : "main";
  if (!token || !rawRepo) return { success: true, message: "Không cấu hình GitHub, bỏ qua." };

  const cleanRepo = rawRepo.replace(/^https?:\/\/github\.com\//i, "").replace(/^\/+|\/+$/g, "");
  const headers = {
    "Authorization": `Bearer ${token}`,
    "Accept": "application/vnd.github+json",
    "User-Agent": "MRD-Cloudflare-Pages"
  };

  try {
    const branchRes = await fetch(`https://api.github.com/repos/${cleanRepo}/branches/${branch}`, { headers });
    if (!branchRes.ok) return { success: true };
    const branchData = await branchRes.json();
    const baseTreeSha = branchData.commit.commit.tree.sha;

    const treeRes = await fetch(`https://api.github.com/repos/${cleanRepo}/git/trees/${baseTreeSha}?recursive=1`, { headers });
    if (!treeRes.ok) return { success: true };
    const treeData = await treeRes.json();

    const oldPrefix = `json/${oldFolder}/`;
    const filesToMove = (treeData.tree || []).filter(item => item.type === "blob" && item.path.startsWith(oldPrefix));
    if (filesToMove.length === 0) return { success: true };

    const filesToCommit = [];
    for (const f of filesToMove) {
      const relPath = f.path.substring(oldPrefix.length);
      filesToCommit.push({
        path: `json/${newFolder}/${relPath}`,
        sha: f.sha
      });
      filesToCommit.push({
        path: f.path,
        sha: null
      });
    }

    return await commitFilesToGitHubBlock(env, filesToCommit, `Rename folder json/${oldFolder} to json/${newFolder}`);
  } catch (err) {
    console.error("Lỗi đổi tên folder GitHub:", err);
    return { success: false, error: err.message };
  }
}

/**
 * Gom toàn bộ các shard tiền tố được chỉ định vào 1 block và đồng bộ 1 lần duy nhất lên GitHub
 * Tự động phân thư mục theo tên bảng bản quyền: json/<licenseShortName>/<prefix>.json
 */
async function syncShardsBlockToGitHub(env, prefixes, customMessage, licenseShortName) {
  if (!prefixes) return { success: true, count: 0 };
  const list = Array.from(new Set(Array.isArray(prefixes) ? prefixes : [prefixes]))
    .map(p => String(p ?? "").trim().toLowerCase())
    .filter(Boolean);

  if (list.length === 0) return { success: true, count: 0 };

  const targetShortName = sanitizeLicenseName(licenseShortName) || "androidtv-x86";
  const actualTable = `${targetShortName}_license`;

  try {
    const filesToCommit = [];
    const xorKey = env?.XOR_KEY;

    const prefixMap = new Map();
    for (const prefix of list) {
      prefixMap.set(prefix, []);
    }

    const CHUNK_SIZE = 50;
    for (let i = 0; i < list.length; i += CHUNK_SIZE) {
      const chunkPrefixes = list.slice(i, i + CHUNK_SIZE);
      const placeholders = chunkPrefixes.map(() => "?").join(",");
      const { results } = await env.DB.prepare(
        `SELECT prefix, serial, rom_version, key_status FROM "${actualTable}" WHERE prefix IN (${placeholders})`
      ).bind(...chunkPrefixes).all();

      for (const row of (results || [])) {
        const p = (row.prefix || "").toLowerCase();
        if (prefixMap.has(p)) {
          prefixMap.get(p).push(row);
        }
      }
    }

    for (const prefix of list) {
      const records = prefixMap.get(prefix) || [];
      const encryptedList = records.map(r => {
        const raw = `${r.serial}:${r.rom_version}:${r.key_status}`;
        return xorEncryptHex(raw, xorKey);
      });

      const fileContent = JSON.stringify(encryptedList, null, 2);
      filesToCommit.push({
        path: `json/${targetShortName}/${prefix}.json`,
        content: fileContent
      });
    }

    return await commitFilesToGitHubBlock(env, filesToCommit, customMessage);
  } catch (err) {
    console.error("Lỗi ngoại lệ syncShardsBlockToGitHub:", err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Đồng bộ file json/<licenseShortName>/giftcode.json lên GitHub
 */
async function syncGiftCodeToGitHub(env, licenseShortName) {
  try {
    const today = new Date().toISOString().split("T")[0];
    const xorKey = env?.XOR_KEY;
    const targetShortName = sanitizeLicenseName(licenseShortName) || "androidtv-x86";

    const { results } = await env.DB.prepare(
      "SELECT gift_code, start_date, expiration_date, extend FROM gift_keys WHERE license_table = ? AND expiration_date >= ? ORDER BY created_at DESC"
    ).bind(targetShortName, today).all();

    const records = (results || []).map(r => {
      const extendVal = r.extend != null ? Number(r.extend) : 7;
      const rawMeta = `${r.start_date}:${r.expiration_date}:${extendVal}`;
      return {
        gift_code: r.gift_code,
        metadata: xorEncryptHex(rawMeta, xorKey)
      };
    });

    const fileContent = JSON.stringify(records, null, 2);
    return await commitFilesToGitHubBlock(env, [{
      path: `json/${targetShortName}/giftcode.json`,
      content: fileContent
    }], `Sync json/${targetShortName}/giftcode.json via MRD License Admin [skip ci]`);
  } catch (err) {
    console.error("Lỗi ngoại lệ syncGiftCodeToGitHub:", err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Chuyển đổi chuỗi có dấu thành không dấu, loại bỏ khoảng trắng và ký tự đặc biệt, viết hoa
 */
function sanitizeCode(str) {
  if (!str) return "";
  return String(str)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[đ]/g, "d")
    .replace(/[Đ]/g, "D")
    .replace(/[^a-zA-Z0-9_\-]/g, "")
    .toUpperCase();
}

/**
 * Chuẩn hóa chuỗi ngày tháng về dạng chuẩn YYYY-MM-DD:
 * - Loại bỏ các ký tự vô hình (Zero-width space, BOM, LTR/RTL mark...)
 * - Thay thế các loại dấu gạch ngang unicode (en-dash, em-dash, minus...), dấu gạch chéo (/), dấu chấm (.) thành dấu gạch ngang chuẩn (-)
 * - Tự động nhận diện và chuyển đổi DD-MM-YYYY hoặc YYYY-M-D thành YYYY-MM-DD
 */
function normalizeDateStr(val) {
  if (!val) return "";
  let s = String(val).trim();
  s = s.replace(/[\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/g, "");
  s = s.replace(/[\u2010-\u2015\u2212\uFF0D\/.]/g, "-");
  s = s.replace(/\s*-\s*/g, "-").trim();

  const dmy = s.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  if (dmy) {
    const day = dmy[1].padStart(2, "0");
    const month = dmy[2].padStart(2, "0");
    const year = dmy[3];
    return `${year}-${month}-${day}`;
  }

  const ymd = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (ymd) {
    const year = ymd[1];
    const month = ymd[2].padStart(2, "0");
    const day = ymd[3].padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  return s;
}

/**
 * Thuật toán phân mảnh theo 2 ký tự đầu của Serial:
 * PREFIX=$(echo "$SERI" | cut -c 1-2 | tr '[:upper:]' '[:lower:]')
 */
function getDevicePrefix(serial) {
  if (!serial) return "un";
  const clean = sanitizeCode(serial).toLowerCase();
  return clean.length >= 2 ? clean.substring(0, 2) : clean.padEnd(2, "0");
}

/**
 * Mã hóa chuỗi text bằng XOR với khóa lặp tuần hoàn (env.XOR_KEY), xuất ra Hex cho Shards
 */
function xorEncryptHex(text, key) {
  if (!key) return "";
  const encoder = new TextEncoder();
  const textBytes = encoder.encode(text);
  const keyBytes = encoder.encode(String(key));
  let hex = "";
  for (let i = 0; i < textBytes.length; i++) {
    const b = textBytes[i] ^ keyBytes[i % keyBytes.length];
    hex += b.toString(16).padStart(2, "0");
  }
  return hex;
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json;charset=utf-8", "Access-Control-Allow-Origin": "*" }
  });
}
