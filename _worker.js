/**
 * Cloudflare Worker: Hệ Thống Bản Quyền MRD Team
 * - Thống kê toàn diện mọi lượt đọc/ghi/truy cập của License (Trần: 50.000 req)
 * - Widget hiển thị số req License đã dùng và số lượng còn lại
 * - Phân mảnh tĩnh theo tiền tố (Prefix Chunking/Sharding): /{prefix}.json
 *   Mã hóa XOR
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const today = new Date().toISOString().split("T")[0];

    // =========================================================================
    // 0. BỘ ĐẾM TOÀN DIỆN MỌI REQUEST CỦA PROJECT LICENSE (CHẠY NỀN QUA ctx.waitUntil)
    // =========================================================================
    if (env.DB) {
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
    const authHeader = request.headers.get("Authorization");
    const isAuthed = authHeader === `Bearer ${adminPassword}`;

    if (url.pathname === "/api/admin/login" && request.method === "POST") {
      try {
        const { password } = await request.json();
        if (password === adminPassword) {
          return jsonResponse({ success: true });
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
          pages_domain: env.PAGES_DOMAIN ? env.PAGES_DOMAIN.replace(/\/+$/, '') : '',
          license_quota: { limit: 50000, used: 0, remaining: 50000 }
        });
      }

      await ensureDbSchema(env);
      const MAX_LICENSE_REQ = 50000; // Trần 50.000 req dành riêng cho License

      // Truy vấn đồng thời dữ liệu bản quyền, ROM, request quota, Gift keys và phiên bản DB
      const [licensesRes, romsRes, statsRes, giftKeysRes, versionRes] = await Promise.all([
        env.DB.prepare("SELECT * FROM licenses ORDER BY id DESC").all(),
        env.DB.prepare("SELECT * FROM rom_categories ORDER BY name ASC").all(),
        env.DB.prepare("SELECT req_count FROM system_stats WHERE date_key = ? AND service_type = 'LICENSE'").bind(today).first(),
        env.DB.prepare("SELECT * FROM gift_keys ORDER BY created_at DESC").all(),
        env.DB.prepare("SELECT req_count FROM system_stats WHERE date_key = 'SYSTEM' AND service_type = 'DB_VERSION'").first()
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
        github_repo: env.GITHUB_REPO ? String(env.GITHUB_REPO).trim() : '',
        pages_domain: env.PAGES_DOMAIN ? env.PAGES_DOMAIN.replace(/\/+$/, '') : '',
        db_version: currentDbVersion,
        license_quota: {
          limit: MAX_LICENSE_REQ,
          used: licenseUsage,
          remaining: Math.max(0, MAX_LICENSE_REQ - licenseUsage)
        }
      });
    }

    if (url.pathname === "/api/admin/action" && request.method === "POST") {
      if (!isAuthed) return jsonResponse({ error: "Unauthorized" }, 401);

      const body = await request.json();
      const { action } = body;

      const mutatingActions = new Set([
        "create_license", "update_license", "delete_license",
        "create_gift_key", "update_gift_key", "delete_gift_key",
        "add_rom", "delete_rom",
        "bulk_delete_licenses", "bulk_update_licenses", "bulk_import_licenses",
        "bulk_delete_gift_keys", "bulk_update_gift_keys",
        "bulk_import_roms"
      ]);
      if (mutatingActions.has(action)) {
        ctx.waitUntil(bumpDbVersion(env));
      }

      if (action === "create_license") {
        const { serial, rom_version, key_status, email_phone, country, note } = body;

        const existing = await env.DB.prepare(
          "SELECT id FROM licenses WHERE serial = ? AND rom_version = ?"
        ).bind(serial, rom_version).first();

        if (existing) {
          return jsonResponse({
            success: false,
            error: `Thiết bị có Serial "${serial}" và Sản phẩm "${rom_version}" đã tồn tại trong hệ thống!`
          }, 400);
        }

        await ensureDbSchema(env);
        const prefix = getDevicePrefix(serial);

        await env.DB.prepare(
          `INSERT INTO licenses (serial, rom_version, key_status, email_phone, country, gmail_notify, note, created_at, prefix)
           VALUES (?, ?, ?, ?, ?, 'NONE', ?, ?, ?)`
        ).bind(serial, rom_version, key_status || 'OK', email_phone || '', country || 'VN', note || '', Date.now(), prefix).run();

        // Tự động đẩy file phân mảnh lên GitHub Repo cho Cloudflare Pages
        const gitRes = await syncShardToGitHub(env, prefix);
        let msg = "Đã thêm thành công!";
        if (gitRes && gitRes.success) {
          msg += ` (Đã lưu json/${prefix}.json lên GitHub)`;
        } else if (gitRes && !gitRes.success) {
          msg += ` (Lưu ý GitHub: ${gitRes.error})`;
        }

        return jsonResponse({ success: true, message: msg, prefix });
      }
      else if (action === "update_license") {
        const { id, serial, rom_version, key_status, email_phone, country, note } = body;

        const duplicate = await env.DB.prepare(
          "SELECT id FROM licenses WHERE serial = ? AND rom_version = ? AND id != ?"
        ).bind(serial, rom_version, id).first();

        if (duplicate) {
          return jsonResponse({
            success: false,
            error: `Không thể lưu! Serial "${serial}" và Sản phẩm "${rom_version}" đã thuộc về mục khác.`
          }, 400);
        }

        await ensureDbSchema(env);
        const oldItem = await env.DB.prepare("SELECT serial, prefix FROM licenses WHERE id = ?").bind(id).first();
        const oldPrefix = oldItem?.prefix || (oldItem ? getDevicePrefix(oldItem.serial) : null);
        const newPrefix = getDevicePrefix(serial);

        await env.DB.prepare(
          `UPDATE licenses SET serial = ?, rom_version = ?, key_status = ?, email_phone = ?, country = ?, note = ?, prefix = ?
           WHERE id = ?`
        ).bind(serial, rom_version, key_status, email_phone || '', country, note || '', newPrefix, id).run();

        // Đồng bộ lên GitHub
        let gitNotice = "";
        if (oldPrefix && oldPrefix !== newPrefix) {
          await syncShardToGitHub(env, oldPrefix);
        }
        if (newPrefix) {
          const gitRes = await syncShardToGitHub(env, newPrefix);
          if (gitRes && !gitRes.success) {
            gitNotice = ` (Lưu ý GitHub: ${gitRes.error})`;
          }
        }

        return jsonResponse({ success: true, message: `Đã cập nhật thành công!${gitNotice}`, prefix: newPrefix });
      }
      else if (action === "delete_license") {
        const oldItem = await env.DB.prepare("SELECT serial, prefix FROM licenses WHERE id = ?").bind(body.id).first();
        const prefix = oldItem?.prefix || (oldItem ? getDevicePrefix(oldItem.serial) : null);

        await env.DB.prepare("DELETE FROM licenses WHERE id = ?").bind(body.id).run();

        let gitNotice = "";
        if (prefix) {
          const gitRes = await syncShardToGitHub(env, prefix);
          if (gitRes && !gitRes.success) {
            gitNotice = ` (Lưu ý GitHub: ${gitRes.error})`;
          }
        }
        return jsonResponse({ success: true, message: `Đã xóa kích hoạt thành công!${gitNotice}` });
      }
      else if (action === "reindex_all_prefixes") {
        await ensureDbSchema(env);
        const { results } = await env.DB.prepare("SELECT id, serial FROM licenses").all();
        let count = 0;
        const purgedPrefixes = new Set();
        for (const row of (results || [])) {
          const p = getDevicePrefix(row.serial);
          await env.DB.prepare("UPDATE licenses SET prefix = ? WHERE id = ?").bind(p, row.id).run();
          count++;
          purgedPrefixes.add(p);
        }

        // Đẩy tất cả các shard phân mảnh lên GitHub Repo cho Pages và thu thập kết quả
        const syncMsgs = [];
        for (const p of purgedPrefixes) {
          const res = await syncShardToGitHub(env, p);
          if (res && res.success) {
            syncMsgs.push(`json/${p}.json: ✅ Thành công`);
          } else {
            syncMsgs.push(`json/${p}.json: ❌ ${res ? res.error : 'Lỗi không xác định'}`);
          }
        }

        // Đồng bộ cả file json/giftcode.json
        const giftRes = await syncGiftCodeToGitHub(env);
        if (giftRes && giftRes.success) {
          syncMsgs.push("json/giftcode.json: ✅ Thành công");
        } else if (giftRes && !giftRes.success) {
          syncMsgs.push(`json/giftcode.json: ❌ ${giftRes.error}`);
        }

        const gitStatus = syncMsgs.length > 0 ? " | GitHub: " + syncMsgs.join("; ") : "";
        return jsonResponse({ success: true, count, message: `Đã đồng bộ ${count} bản ghi D1.${gitStatus}` });
      }
      else if (action === "create_gift_key") {
        const { gift_code, start_date, expiration_date, note } = body;
        if (!gift_code || !start_date || !expiration_date) {
          return jsonResponse({ success: false, error: "Thiếu thông tin GIFT_CODE hoặc ngày hiệu lực" }, 400);
        }

        await ensureDbSchema(env);
        const existing = await env.DB.prepare(
          "SELECT id FROM gift_keys WHERE gift_code = ?"
        ).bind(gift_code.trim()).first();

        if (existing) {
          return jsonResponse({ success: false, error: `Gift code "${gift_code}" đã tồn tại trong hệ thống!` }, 400);
        }

        await env.DB.prepare(`
          INSERT INTO gift_keys (gift_code, start_date, expiration_date, note, created_at)
          VALUES (?, ?, ?, ?, ?)
        `).bind(gift_code.trim(), start_date.trim(), expiration_date.trim(), note || '', Date.now()).run();

        const gitRes = await syncGiftCodeToGitHub(env);
        let msg = "Đã tạo Gift Code thành công!";
        if (gitRes && gitRes.success) {
          msg += " (Đã lưu json/giftcode.json lên GitHub)";
        } else if (gitRes && !gitRes.success) {
          msg += ` (Lưu ý GitHub: ${gitRes.error})`;
        }

        return jsonResponse({ success: true, message: msg });
      }
      else if (action === "update_gift_key") {
        const { id, gift_code, start_date, expiration_date, note } = body;
        if (!id || !gift_code || !start_date || !expiration_date) {
          return jsonResponse({ success: false, error: "Thiếu dữ liệu cập nhật Gift Code" }, 400);
        }

        await ensureDbSchema(env);
        const duplicate = await env.DB.prepare(
          "SELECT id FROM gift_keys WHERE gift_code = ? AND id != ?"
        ).bind(gift_code.trim(), id).first();

        if (duplicate) {
          return jsonResponse({ success: false, error: `Gift code "${gift_code}" đã thuộc về mục khác!` }, 400);
        }

        await env.DB.prepare(`
          UPDATE gift_keys SET gift_code = ?, start_date = ?, expiration_date = ?, note = ?
          WHERE id = ?
        `).bind(gift_code.trim(), start_date.trim(), expiration_date.trim(), note || '', id).run();

        const gitRes = await syncGiftCodeToGitHub(env);
        let msg = "Đã cập nhật Gift Code thành công!";
        if (gitRes && !gitRes.success) {
          msg += ` (Lưu ý GitHub: ${gitRes.error})`;
        }

        return jsonResponse({ success: true, message: msg });
      }
      else if (action === "delete_gift_key") {
        await env.DB.prepare("DELETE FROM gift_keys WHERE id = ?").bind(body.id).run();

        const gitRes = await syncGiftCodeToGitHub(env);
        let msg = "Đã xóa Gift Code thành công!";
        if (gitRes && !gitRes.success) {
          msg += ` (Lưu ý GitHub: ${gitRes.error})`;
        }
        return jsonResponse({ success: true, message: msg });
      }
      else if (action === "sync_gift_code") {
        const gitRes = await syncGiftCodeToGitHub(env);
        if (gitRes && gitRes.success) {
          return jsonResponse({ success: true, message: "Đã lưu json/giftcode.json lên GitHub thành công!" });
        } else {
          return jsonResponse({ success: false, error: gitRes ? gitRes.error : "Lỗi không xác định" });
        }
      }
      else if (action === "add_rom") {
        const { name } = body;
        if (!name) return jsonResponse({ error: "Tên Sản phẩm không được để trống" }, 400);
        await env.DB.prepare("INSERT OR IGNORE INTO rom_categories (name) VALUES (?)").bind(name.trim()).run();
      }
      else if (action === "delete_rom") {
        await env.DB.prepare("DELETE FROM rom_categories WHERE name = ?").bind(body.name).run();
      }
      else if (action === "bulk_delete_licenses") {
        const { ids } = body;
        if (!Array.isArray(ids) || ids.length === 0) {
          return jsonResponse({ success: false, error: "Danh sách ID không hợp lệ" }, 400);
        }
        await ensureDbSchema(env);
        const placeholders = ids.map(() => "?").join(",");
        const oldItems = await env.DB.prepare(`SELECT serial, prefix FROM licenses WHERE id IN (${placeholders})`).bind(...ids).all();
        const affectedPrefixes = new Set();
        (oldItems.results || []).forEach(row => {
          const p = row.prefix || getDevicePrefix(row.serial);
          if (p) affectedPrefixes.add(p);
        });

        await env.DB.prepare(`DELETE FROM licenses WHERE id IN (${placeholders})`).bind(...ids).run();

        for (const p of affectedPrefixes) {
          await syncShardToGitHub(env, p);
        }

        return jsonResponse({ success: true, count: ids.length, message: `Đã xóa thành công ${ids.length} mục!` });
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
          const newPrefix = getDevicePrefix(it.serial);
          affectedPrefixes.add(newPrefix);
          if (it.old_prefix) affectedPrefixes.add(it.old_prefix);

          stmts.push(
            env.DB.prepare(
              `UPDATE licenses SET serial = ?, rom_version = ?, key_status = ?, email_phone = ?, country = ?, gmail_notify = ?, note = ?, prefix = ? WHERE id = ?`
            ).bind(
              it.serial.trim(),
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

        if (stmts.length > 0) {
          for (let i = 0; i < stmts.length; i += 100) {
            await env.DB.batch(stmts.slice(i, i + 100));
          }
        }

        for (const p of affectedPrefixes) {
          await syncShardToGitHub(env, p);
        }

        return jsonResponse({ success: true, count: stmts.length, message: `Đã lưu và đồng bộ thành công ${stmts.length} mục!` });
      }
      else if (action === "bulk_import_licenses") {
        const { items } = body;
        if (!Array.isArray(items) || items.length === 0) {
          return jsonResponse({ success: false, error: "Dữ liệu nhập không hợp lệ" }, 400);
        }
        await ensureDbSchema(env);

        const existingRes = await env.DB.prepare("SELECT serial, rom_version FROM licenses").all();
        const existingSet = new Set((existingRes.results || []).map(r => `${(r.serial || '').trim()}_${(r.rom_version || '').trim()}`));

        const affectedPrefixes = new Set();
        const stmts = [];
        let skipped = 0;

        for (const it of items) {
          const s = (it.serial || '').trim();
          const r = (it.rom_version || '').trim();
          if (!s || !r) continue;

          const keyPair = `${s}_${r}`;
          if (existingSet.has(keyPair)) {
            skipped++;
            continue;
          }
          existingSet.add(keyPair);

          const prefix = getDevicePrefix(s);
          affectedPrefixes.add(prefix);

          stmts.push(
            env.DB.prepare(
              `INSERT INTO licenses (serial, rom_version, key_status, email_phone, country, gmail_notify, note, created_at, prefix)
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

        if (stmts.length > 0) {
          for (let i = 0; i < stmts.length; i += 100) {
            await env.DB.batch(stmts.slice(i, i + 100));
          }
        }

        for (const p of affectedPrefixes) {
          await syncShardToGitHub(env, p);
        }

        return jsonResponse({
          success: true,
          imported: stmts.length,
          skipped,
          message: `Đã nhập thành công ${stmts.length} mục (Bỏ qua ${skipped} mục trùng lặp)!`
        });
      }
      else if (action === "bulk_delete_gift_keys") {
        const { ids } = body;
        if (!Array.isArray(ids) || ids.length === 0) {
          return jsonResponse({ success: false, error: "Danh sách ID không hợp lệ" }, 400);
        }
        await ensureDbSchema(env);
        const placeholders = ids.map(() => "?").join(",");
        await env.DB.prepare(`DELETE FROM gift_keys WHERE id IN (${placeholders})`).bind(...ids).run();

        await syncGiftCodeToGitHub(env);

        return jsonResponse({ success: true, count: ids.length, message: `Đã xóa thành công ${ids.length} Gift Code!` });
      }
      else if (action === "bulk_update_gift_keys") {
        const { items } = body;
        if (!Array.isArray(items) || items.length === 0) {
          return jsonResponse({ success: false, error: "Dữ liệu cập nhật không hợp lệ" }, 400);
        }
        await ensureDbSchema(env);
        const stmts = [];
        for (const it of items) {
          if (!it.id || !it.gift_code || !it.start_date || !it.expiration_date) continue;
          stmts.push(
            env.DB.prepare(
              `UPDATE gift_keys SET gift_code = ?, start_date = ?, expiration_date = ?, note = ? WHERE id = ?`
            ).bind(it.gift_code.trim(), it.start_date.trim(), it.expiration_date.trim(), it.note || '', it.id)
          );
        }
        if (stmts.length > 0) {
          for (let i = 0; i < stmts.length; i += 100) {
            await env.DB.batch(stmts.slice(i, i + 100));
          }
        }
        await syncGiftCodeToGitHub(env);

        return jsonResponse({ success: true, count: stmts.length, message: `Đã cập nhật ${stmts.length} Gift Code!` });
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
          stmts.push(env.DB.prepare("INSERT OR IGNORE INTO rom_categories (name) VALUES (?)").bind(name));
        }
        if (stmts.length > 0) {
          for (let i = 0; i < stmts.length; i += 100) {
            await env.DB.batch(stmts.slice(i, i + 100));
          }
        }
        return jsonResponse({ success: true, count: stmts.length, message: `Đã thêm thành công ${stmts.length} sản phẩm!` });
      }
      else if (action === "resend_mail") {
        const item = await env.DB.prepare("SELECT * FROM licenses WHERE id = ?").bind(body.id).first();
        if (!item || !item.email_phone || !item.email_phone.includes("@")) {
          return jsonResponse({ success: false, error: "Email không hợp lệ" }, 400);
        }

        if (!env.GAS_WEBAPP_URL) {
          return jsonResponse({ success: false, error: "Chưa cấu hình GAS_WEBAPP_URL trong Settings!" }, 500);
        }

        try {
          const gasRes = await fetch(env.GAS_WEBAPP_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            redirect: "follow",
            body: JSON.stringify({
              secret: env.INTERNAL_SECRET,
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
            await env.DB.prepare("UPDATE licenses SET gmail_notify = 'SENT' WHERE id = ?").bind(item.id).run();
            return jsonResponse({ success: true, ref_id: gasJson.ref_id });
          } else {
            await env.DB.prepare("UPDATE licenses SET gmail_notify = 'ERROR' WHERE id = ?").bind(item.id).run();
            return jsonResponse({ success: false, error: gasJson.error || gasText });
          }
        } catch (callErr) {
          await env.DB.prepare("UPDATE licenses SET gmail_notify = 'ERROR' WHERE id = ?").bind(item.id).run();
          return jsonResponse({ success: false, error: "Không kết nối được tới Google Apps Script: " + callErr.message }, 500);
        }
      }

      return jsonResponse({ success: true });
    }

    // =========================================================================
    // 4. GIAO DIỆN WEB ADMIN (/admin)
    // =========================================================================
    if (url.pathname === "/admin") {
      return new Response(renderAdminHTML(), {
        headers: { "Content-Type": "text/html; charset=utf-8" }
      });
    }

    return new Response("Not Found", { status: 404 });
  }
};

let schemaChecked = false;

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

async function ensureDbSchema(env) {
  if (schemaChecked || !env?.DB) return;

  try {
    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS licenses (
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
    await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_licenses_prefix ON licenses(prefix)").run();
    await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_licenses_serial_rom ON licenses(serial, rom_version)").run();
  } catch (e) {
    // Bỏ qua lỗi tạo bảng licenses
  }

  try {
    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS gift_keys (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        gift_code TEXT UNIQUE NOT NULL,
        start_date TEXT NOT NULL,
        expiration_date TEXT NOT NULL,
        note TEXT,
        created_at INTEGER
      )
    `).run();
    await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_gift_keys_code ON gift_keys(gift_code)").run();
  } catch (e) {
    // Bỏ qua lỗi tạo bảng gift_keys
  }

  try {
    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS rom_categories (
        name TEXT PRIMARY KEY
      )
    `).run();
  } catch (e) {
    // Bỏ qua lỗi tạo bảng rom_categories
  }

  try {
    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS system_stats (
        date_key TEXT,
        service_type TEXT,
        req_count INTEGER DEFAULT 0,
        PRIMARY KEY (date_key, service_type)
      )
    `).run();
  } catch (e) {
    // Bỏ qua lỗi tạo bảng system_stats
  }

  schemaChecked = true;
}

/**
 * Tự động đồng bộ file json/giftcode.json lên GitHub Repo
 */
async function syncGiftCodeToGitHub(env) {
  const token = env?.GITHUB_TOKEN ? String(env.GITHUB_TOKEN).trim() : null;
  const rawRepo = env?.GITHUB_REPO ? String(env.GITHUB_REPO).trim() : null;

  if (!token) {
    return { success: false, error: "Chưa cấu hình biến GITHUB_TOKEN trong Settings -> Environment variables của Pages" };
  }
  if (!rawRepo) {
    return { success: false, error: "Chưa cấu hình biến GITHUB_REPO trong Settings -> Environment variables của Pages" };
  }

  const cleanRepo = rawRepo
    .replace(/^https?:\/\/github\.com\//i, "")
    .replace(/^\/+|\/+$/g, "");

  try {
    const { results } = await env.DB.prepare(
      "SELECT gift_code, start_date, expiration_date FROM gift_keys ORDER BY created_at DESC"
    ).all();

    const records = results || [];
    const xorKey = env?.XOR_KEY;

    // Format: GIFT_CODE:START_DATE:EXPIRATION_DATE -> XOR encrypt với khóa env.XOR_KEY -> Hex
    const encryptedList = records.map(r => {
      const raw = `${r.gift_code}:${r.start_date}:${r.expiration_date}`;
      return xorEncryptHex(raw, xorKey);
    });

    const fileContent = JSON.stringify(encryptedList, null, 2);
    let binary = "";
    const encoder = new TextEncoder();
    const utf8Bytes = encoder.encode(fileContent);
    for (let i = 0; i < utf8Bytes.length; i++) {
      binary += String.fromCharCode(utf8Bytes[i]);
    }
    const contentBase64 = btoa(binary);

    const filePath = "json/giftcode.json";
    const apiUrl = `https://api.github.com/repos/${cleanRepo}/contents/${filePath}`;
    const headers = {
      "Authorization": `Bearer ${token}`,
      "Accept": "application/vnd.github+json",
      "User-Agent": "MRD-Cloudflare-Pages"
    };

    let existingSha = null;
    try {
      const getRes = await fetch(apiUrl, { headers });
      if (getRes.ok) {
        const fileInfo = await getRes.json();
        existingSha = fileInfo.sha;
      }
    } catch (e) {
      // File chưa tồn tại
    }

    const putBody = {
      message: `Sync ${filePath} via MRD License Admin [skip ci]`,
      content: contentBase64
    };
    if (existingSha) {
      putBody.sha = existingSha;
    }

    const putRes = await fetch(apiUrl, {
      method: "PUT",
      headers: {
        ...headers,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(putBody)
    });

    if (!putRes.ok) {
      const errText = await putRes.text();
      let errMsg = errText;
      try {
        const errJson = JSON.parse(errText);
        if (errJson.message) errMsg = errJson.message;
      } catch (_) { }
      console.error(`Lỗi đẩy file ${filePath} lên GitHub:`, errMsg);
      return { success: false, error: `GitHub API HTTP ${putRes.status}: ${errMsg}` };
    }

    return { success: true };
  } catch (err) {
    console.error(`Lỗi ngoại lệ syncGiftCodeToGitHub:`, err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Tự động đồng bộ file {prefix}.json lên GitHub Repo đã liên kết với Cloudflare Pages
 */
async function syncShardToGitHub(env, prefix) {
  if (!prefix) return { success: false, error: "Thiếu prefix" };

  const token = env?.GITHUB_TOKEN ? String(env.GITHUB_TOKEN).trim() : null;
  const rawRepo = env?.GITHUB_REPO ? String(env.GITHUB_REPO).trim() : null;

  if (!token) {
    return { success: false, error: "Chưa cấu hình biến GITHUB_TOKEN trong Settings -> Environment variables của Pages" };
  }
  if (!rawRepo) {
    return { success: false, error: "Chưa cấu hình biến GITHUB_REPO trong Settings -> Environment variables của Pages" };
  }

  const cleanRepo = rawRepo
    .replace(/^https?:\/\/github\.com\//i, "")
    .replace(/^\/+|\/+$/g, "");

  try {
    const { results } = await env.DB.prepare(
      "SELECT serial, rom_version, key_status FROM licenses WHERE prefix = ?"
    ).bind(prefix).all();

    const records = results || [];

    // Format: SERIAL:ROM_VERSION:KEY_STATUS -> XOR encrypt với khóa env.XOR_KEY -> Hex
    const xorKey = env?.XOR_KEY;
    const encryptedList = records.map(r => {
      const raw = `${r.serial}:${r.rom_version}:${r.key_status}`;
      return xorEncryptHex(raw, xorKey);
    });

    const fileContent = JSON.stringify(encryptedList, null, 2);
    let binary = "";
    const encoder = new TextEncoder();
    const utf8Bytes = encoder.encode(fileContent);
    for (let i = 0; i < utf8Bytes.length; i++) {
      binary += String.fromCharCode(utf8Bytes[i]);
    }
    const contentBase64 = btoa(binary);

    const filePath = `json/${prefix}.json`;
    const apiUrl = `https://api.github.com/repos/${cleanRepo}/contents/${filePath}`;
    const headers = {
      "Authorization": `Bearer ${token}`,
      "Accept": "application/vnd.github+json",
      "User-Agent": "MRD-Cloudflare-Pages"
    };

    // Kiểm tra file đã có trên GitHub chưa để lấy SHA (bắt buộc khi cập nhật file)
    let existingSha = null;
    try {
      const getRes = await fetch(apiUrl, { headers });
      if (getRes.ok) {
        const fileInfo = await getRes.json();
        existingSha = fileInfo.sha;
      }
    } catch (e) {
      // File chưa tồn tại
    }

    const putBody = {
      message: `Sync shard ${filePath} via MRD License Admin [skip ci]`,
      content: contentBase64
    };
    if (existingSha) {
      putBody.sha = existingSha;
    }

    const putRes = await fetch(apiUrl, {
      method: "PUT",
      headers: {
        ...headers,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(putBody)
    });

    if (!putRes.ok) {
      const errText = await putRes.text();
      let errMsg = errText;
      try {
        const errJson = JSON.parse(errText);
        if (errJson.message) errMsg = errJson.message;
      } catch (_) { }
      console.error(`Lỗi đẩy file ${filePath} lên GitHub:`, errMsg);
      return { success: false, error: `GitHub API HTTP ${putRes.status}: ${errMsg}` };
    }

    return { success: true };
  } catch (err) {
    console.error(`Lỗi ngoại lệ syncShardToGitHub (${prefix}):`, err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Thuật toán phân mảnh theo 2 ký tự đầu của Serial:
 * PREFIX=$(echo "$SERI" | cut -c 1-2 | tr '[:upper:]' '[:lower:]')
 */
function getDevicePrefix(serial) {
  if (!serial) return "un";
  const clean = String(serial).trim().replace(/[^a-zA-Z0-9_-]/g, "").toLowerCase();
  return clean.length >= 2 ? clean.substring(0, 2) : clean.padEnd(2, "0");
}

/**
 * Mã hóa chuỗi text bằng XOR với khóa lặp tuần hoàn (env.XOR_KEY), xuất ra Hex
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



async function sendMailAndUpdateStatus(env, device) {
  if (!env.GAS_WEBAPP_URL) return;
  try {
    const res = await fetch(env.GAS_WEBAPP_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      redirect: "follow",
      body: JSON.stringify({
        secret: env.INTERNAL_SECRET,
        email: device.email_phone,
        serial: device.serial,
        rom_version: device.rom_version,
        country: device.country
      })
    });

    const resText = await res.text();
    let resJson = {};
    try { resJson = JSON.parse(resText); } catch (e) { }

    if (resJson.success || resText.includes("OK")) {
      await env.DB.prepare("UPDATE licenses SET gmail_notify = 'SENT' WHERE id = ?").bind(device.id).run();
    } else {
      await env.DB.prepare("UPDATE licenses SET gmail_notify = 'ERROR' WHERE id = ?").bind(device.id).run();
    }
  } catch (err) {
    await env.DB.prepare("UPDATE licenses SET gmail_notify = 'ERROR' WHERE id = ?").bind(device.id).run();
  }
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json;charset=utf-8", "Access-Control-Allow-Origin": "*" }
  });
}

function renderAdminHTML() {
  return `<!DOCTYPE html>
<html lang="vi" data-theme="light">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>MRD Team - Quản Lý Kích hoạt Thiết bị</title>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js"></script>
  <style>
    :root[data-theme="light"] {
      --bg-body: #f8fafc;
      --bg-card: #ffffff;
      --text-main: #0f172a;
      --text-muted: #64748b;
      --border-color: #e2e8f0;
      --table-header: #f8fafc;
      --table-hover: #f1f5f9;
      --sidebar-bg: #ffffff;
      --sidebar-border: #e2e8f0;
      --sidebar-text: #475569;
      --sidebar-hover: #f1f5f9;
      --sidebar-active: #f1f5f9;
      --sidebar-active-text: #0f172a;
      --quota-bg: #f8fafc;
      --quota-border: #e2e8f0;
      --modal-overlay: rgba(15, 23, 42, 0.45);
      --dropdown-bg: #ffffff;
      --dropdown-hover: #f1f5f9;
      --dropdown-border: #e2e8f0;
      --dropdown-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.1), 0 8px 10px -6px rgba(0, 0, 0, 0.05);
      --input-bg: #ffffff;
      --input-border: #cbd5e1;
      --badge-ok-bg: #dcfce7;
      --badge-ok-color: #15803d;
      --badge-ok-border: #bbf7d0;
      --badge-off-bg: #fef3c7;
      --badge-off-color: #b45309;
      --badge-off-border: #fde68a;
      --badge-del-bg: #fee2e2;
      --badge-del-color: #b91c1c;
      --badge-del-border: #fecaca;
      --badge-shard-bg: #eff6ff;
      --badge-shard-color: #2563eb;
      --badge-shard-border: #bfdbfe;
    }

    :root[data-theme="dark"] {
      --bg-body: #18181b;
      --bg-card: #222225;
      --text-main: #f4f4f5;
      --text-muted: #a1a1aa;
      --border-color: #2e2e33;
      --table-header: #1c1c1f;
      --table-hover: #28282d;
      --sidebar-bg: #18181b;
      --sidebar-border: #27272a;
      --sidebar-text: #a1a1aa;
      --sidebar-hover: #27272a;
      --sidebar-active: #27272a;
      --sidebar-active-text: #ffffff;
      --quota-bg: #1e1e22;
      --quota-border: #2e2e33;
      --modal-overlay: rgba(0, 0, 0, 0.75);
      --dropdown-bg: #222225;
      --dropdown-hover: #2b2b30;
      --dropdown-border: #333338;
      --dropdown-shadow: 0 14px 28px -4px rgba(0, 0, 0, 0.5), 0 10px 10px -5px rgba(0, 0, 0, 0.3);
      --input-bg: #1c1c1f;
      --input-border: #333338;
      --badge-ok-bg: rgba(16, 185, 129, 0.15);
      --badge-ok-color: #34d399;
      --badge-ok-border: rgba(16, 185, 129, 0.3);
      --badge-off-bg: rgba(245, 158, 11, 0.15);
      --badge-off-color: #fbbf24;
      --badge-off-border: rgba(245, 158, 11, 0.3);
      --badge-del-bg: rgba(239, 68, 68, 0.15);
      --badge-del-color: #f87171;
      --badge-del-border: rgba(239, 68, 68, 0.3);
      --badge-shard-bg: rgba(56, 189, 248, 0.12);
      --badge-shard-color: #38bdf8;
      --badge-shard-border: rgba(56, 189, 248, 0.28);
    }

    * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; margin: 0; padding: 0; }
    body { background: var(--bg-body); color: var(--text-main); display: flex; height: 100vh; overflow: hidden; transition: background 0.25s, color 0.25s; }

    #authOverlay {
      position: fixed; top: 0; left: 0; width: 100%; height: 100%;
      background: var(--modal-overlay); backdrop-filter: blur(8px);
      display: flex; align-items: center; justify-content: center; z-index: 9999; padding: 20px;
    }
    .auth-card {
      background: var(--bg-card); padding: 32px 28px; border-radius: 14px; width: 100%; max-width: 380px;
      box-shadow: var(--dropdown-shadow); text-align: center; border: 1px solid var(--border-color);
    }
    .auth-card h3 { margin-bottom: 8px; color: var(--text-main); font-size: 20px; font-weight: 700; }
    .auth-card p { color: var(--text-muted); font-size: 13px; margin-bottom: 20px; }
    .auth-card input {
      width: 100%; padding: 12px 14px; border: 1px solid var(--input-border); border-radius: 8px;
      background: var(--input-bg); color: var(--text-main); font-size: 15px; margin-bottom: 16px; outline: none; transition: border-color 0.2s;
    }
    .auth-card input:focus { border-color: #0284c7; }
    .auth-card button {
      width: 100%; padding: 12px; background: #0284c7; color: #fff; font-weight: 600;
      border: none; border-radius: 8px; cursor: pointer; font-size: 15px; transition: opacity 0.2s;
    }
    .auth-card button:hover { opacity: 0.9; }

    .sidebar {
      width: 250px; background: var(--sidebar-bg); border-right: 1px solid var(--sidebar-border);
      color: var(--sidebar-text); display: flex; flex-direction: column;
      flex-shrink: 0; z-index: 50; transition: transform 0.3s ease, background 0.25s;
    }
    .brand {
      padding: 18px 20px; font-size: 16px; font-weight: 700; border-bottom: 1px solid var(--sidebar-border);
      color: var(--text-main); display: flex; justify-content: space-between; align-items: center;
    }
    .nav-list { list-style: none; padding: 12px 8px; flex: 1; }
    .nav-item {
      padding: 10px 14px; margin: 3px 4px; border-radius: 8px; cursor: pointer; font-size: 13.5px; font-weight: 500;
      color: var(--sidebar-text); display: flex; align-items: center; gap: 10px; transition: all 0.15s ease;
    }
    .nav-item:hover { background: var(--sidebar-hover); color: var(--text-main); }
    .nav-item.active { background: var(--sidebar-active); color: var(--sidebar-active-text); font-weight: 600; }
    .sidebar-footer { padding: 15px 16px; display: flex; flex-direction: column; gap: 8px; border-top: 1px solid var(--sidebar-border); }
    .btn-logout { background: none; border: none; color: #ef4444; font-size: 13px; font-weight: 600; cursor: pointer; text-align: left; padding: 6px 8px; border-radius: 6px; transition: background 0.15s; }
    .btn-logout:hover { background: var(--sidebar-hover); }

    /* KHỐI HIỂN THỊ QUOTA BẢN QUYỀN */
    .quota-box {
      background: var(--quota-bg);
      border: 1px solid var(--quota-border);
      border-radius: 8px;
      padding: 10px 12px;
      margin-bottom: 6px;
    }
    .quota-title {
      font-size: 11px;
      color: var(--text-muted);
      font-weight: 600;
      display: flex;
      justify-content: space-between;
      margin-bottom: 4px;
    }
    .quota-number {
      font-size: 13px;
      font-weight: bold;
      color: #0284c7;
    }
    [data-theme="dark"] .quota-number {
      color: #38bdf8;
    }
    .quota-sub {
      font-size: 11px;
      color: var(--text-muted);
      margin-top: 2px;
    }
    .quota-bar-bg {
      background: var(--border-color);
      border-radius: 4px;
      height: 5px;
      width: 100%;
      overflow: hidden;
      margin-top: 6px;
    }
    .quota-bar-fill {
      height: 100%;
      background: #0284c7;
      border-radius: 4px;
      transition: width 0.3s;
    }
    [data-theme="dark"] .quota-bar-fill {
      background: #38bdf8;
    }

    .content-area { 
      flex: 1; display: flex; flex-direction: column; 
      overflow-y: auto; overflow-x: hidden; min-width: 0; width: 100%; 
    }
    .topbar {
      background: var(--bg-card); padding: 12px 20px; border-bottom: 1px solid var(--border-color);
      display: flex; justify-content: space-between; align-items: center; flex-shrink: 0;
    }
    .topbar-left { display: flex; align-items: center; gap: 12px; }
    .menu-toggle-btn { display: none; background: none; border: none; font-size: 20px; color: var(--text-main); cursor: pointer; }

    /* THEME DROPDOWN STYLES */
    .theme-dropdown-container { position: relative; }
    .theme-toggle-btn {
      background: var(--bg-card); border: 1px solid var(--border-color); color: var(--text-main);
      padding: 6px 14px; border-radius: 20px; cursor: pointer; font-size: 13px; font-weight: 500;
      display: inline-flex; align-items: center; gap: 6px; transition: all 0.2s;
    }
    .theme-toggle-btn:hover { background: var(--table-hover); }
    @keyframes iconSpin {
      0% { transform: rotate(0deg); }
      100% { transform: rotate(360deg); }
    }
    .sync-icon { display: inline-block; transition: transform 0.2s ease; }
    .sync-icon.spinning {
      animation: iconSpin 0.7s linear infinite;
    }
    .theme-dropdown-menu {
      position: absolute; top: calc(100% + 6px); right: 0; min-width: 160px;
      background: var(--dropdown-bg); border: 1px solid var(--dropdown-border);
      border-radius: 10px; box-shadow: var(--dropdown-shadow);
      display: none; flex-direction: column; padding: 6px 0; z-index: 100;
      animation: menuPop 0.15s ease-out;
    }
    .theme-dropdown-menu.show { display: flex; }
    @keyframes menuPop {
      from { opacity: 0; transform: translateY(-4px); }
      to { opacity: 1; transform: translateY(0); }
    }
    .theme-dropdown-header {
      padding: 6px 14px 4px 14px; font-size: 11px; font-weight: 600;
      color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px;
    }
    .theme-dropdown-item {
      padding: 8px 14px; font-size: 13px; color: var(--text-main);
      cursor: pointer; display: flex; align-items: center; justify-content: space-between;
      transition: background 0.15s;
    }
    .theme-dropdown-item:hover { background: var(--dropdown-hover); }
    .theme-dropdown-item.active { font-weight: 600; color: #0284c7; }
    [data-theme="dark"] .theme-dropdown-item.active { color: #38bdf8; }

    .tab-content { display: none; padding: 20px; width: 100%; max-width: 1400px; margin: 0 auto; }
    .tab-content.active { display: block; }

    .card {
      background: var(--bg-card); border-radius: 12px; border: 1px solid var(--border-color);
      padding: 22px; box-shadow: 0 1px 3px 0 rgba(0, 0, 0, 0.04);
    }
    .table-container { overflow-x: auto; width: 100%; border-radius: 8px; border: 1px solid var(--border-color); }
    table { width: 100%; border-collapse: collapse; text-align: center; font-size: 13px; }
    th, td { padding: 11px 12px; border-bottom: 1px solid var(--border-color); white-space: nowrap; text-align: center; }
    th { background: var(--table-header); color: var(--text-muted); font-weight: 600; text-transform: uppercase; font-size: 11px; letter-spacing: 0.5px; text-align: center; }
    .col-cb { width: 44px; min-width: 44px; max-width: 44px; padding: 11px 4px !important; text-align: center; }
    .col-stt { width: 50px; min-width: 50px; max-width: 55px; padding: 11px 4px !important; text-align: center; }
    .col-actions { width: 110px; min-width: 110px; text-align: center; }
    .col-note { text-align: left !important; width: 100%; min-width: 150px; }
    #romTab table { text-align: left; }
    #romTab table th, #romTab table td { text-align: left; }
    #romTab table th:last-child, #romTab table td:last-child { text-align: center; }
    tbody tr { cursor: pointer; transition: background 0.15s; }
    tbody tr:hover { background: var(--table-hover); }

    .badge { padding: 3px 10px; border-radius: 20px; font-size: 11px; font-weight: 600; display: inline-block; border: 1px solid transparent; }
    .badge-OK { background: var(--badge-ok-bg); color: var(--badge-ok-color); border-color: var(--badge-ok-border); }
    .badge-DEL { background: var(--badge-del-bg); color: var(--badge-del-color); border-color: var(--badge-del-border); }
    .badge-SENT { background: #e0f2fe; color: #0369a1; border-color: #bae6fd; }
    .badge-ERROR { background: var(--badge-del-bg); color: var(--badge-del-color); border-color: var(--badge-del-border); }
    .badge-NONE { background: var(--table-hover); color: var(--text-muted); border-color: var(--border-color); }
    .badge-shard { background: var(--badge-shard-bg); color: var(--badge-shard-color); border-color: var(--badge-shard-border); font-family: monospace; font-size: 11px; }

    .form-group { margin-bottom: 14px; }
    .form-group label { display: block; font-size: 12px; font-weight: 600; color: var(--text-muted); margin-bottom: 6px; text-transform: uppercase; }
    .form-group input, .form-group select {
      width: 100%; padding: 10px 12px; border: 1px solid var(--input-border); border-radius: 8px;
      background: var(--input-bg); color: var(--text-main); font-size: 14px; outline: none; transition: border-color 0.2s;
    }
    .form-group input:focus, .form-group select:focus { border-color: #0284c7; box-shadow: 0 0 0 3px rgba(2, 132, 199, 0.15); }
    .form-group input:disabled, .form-group select:disabled { opacity: 0.7; cursor: not-allowed; }

    .btn { padding: 9px 16px; border: none; border-radius: 8px; cursor: pointer; font-weight: 600; font-size: 13px; transition: 0.2s; display: inline-flex; align-items: center; justify-content: center; gap: 6px; }
    .btn-blue { background: #0284c7; color: #fff; }
    .btn-green { background: #16a34a; color: #fff; }
    .btn-red { background: #dc2626; color: #fff; }
    .btn-gray { background: #64748b; color: #fff; }
    .btn:hover:not(:disabled) { opacity: 0.9; }
    .btn:disabled, .btn.loading {
      opacity: 0.65 !important;
      cursor: not-allowed !important;
      pointer-events: none !important;
      filter: grayscale(25%);
    }
    .btn-spinner {
      width: 13px; height: 13px; border: 2px solid rgba(255, 255, 255, 0.35);
      border-top-color: #fff; border-radius: 50%;
      animation: spinLoader 0.75s linear infinite; display: inline-block;
      flex-shrink: 0;
    }

    .modal-backdrop {
      position: fixed; top: 0; left: 0; width: 100%; height: 100%;
      background: var(--modal-overlay); backdrop-filter: blur(4px);
      display: none; align-items: center; justify-content: center; z-index: 10000; padding: 15px;
    }
    .modal-box {
      background: var(--bg-card); border: 1px solid var(--border-color); border-radius: 14px;
      width: 100%; max-width: 520px; max-height: 90vh; overflow-y: auto; padding: 24px;
      box-shadow: var(--dropdown-shadow);
    }
    .modal-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }
    .modal-header h3 { font-size: 17px; font-weight: 700; color: var(--text-main); }
    .close-btn { font-size: 20px; cursor: pointer; color: var(--text-muted); }
    .modal-footer { display: flex; justify-content: flex-end; gap: 10px; margin-top: 20px; border-top: 1px solid var(--border-color); padding-top: 16px; }

    #toastContainer { position: fixed; top: 20px; right: 20px; z-index: 10001; display: flex; flex-direction: column; gap: 10px; }
    .toast-msg {
      background: var(--bg-card); color: var(--text-main); border: 1px solid var(--border-color);
      padding: 12px 18px; border-radius: 8px; font-size: 13px; font-weight: 500;
      box-shadow: var(--dropdown-shadow); animation: slideIn 0.3s ease;
      display: flex; align-items: center; gap: 8px; max-width: 350px;
    }
    .toast-success { border-left: 4px solid #16a34a; }
    .toast-error { border-left: 4px solid #dc2626; }
    .toast-warn { border-left: 4px solid #f59e0b; }
    .toast-info { border-left: 4px solid #0284c7; }
    @keyframes slideIn { from { transform: translateX(100%); opacity: 0; } to { transform: translateX(0); opacity: 1; } }

    .sidebar-backdrop { display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.5); z-index: 40; }

    /* SEARCH & FILTER STYLES */
    .filter-bar {
      display: flex; gap: 10px; align-items: center; margin-bottom: 14px; flex-wrap: wrap;
    }
    .search-input-wrap {
      position: relative; flex: 1; min-width: 220px;
    }
    .search-input-wrap input {
      width: 100%; padding: 8px 12px 8px 34px; border: 1px solid var(--input-border);
      border-radius: 20px; background: var(--input-bg); color: var(--text-main);
      font-size: 13px; outline: none; transition: border-color 0.2s;
    }
    .search-input-wrap input:focus { border-color: #0284c7; }
    .search-icon {
      position: absolute; left: 12px; top: 50%; transform: translateY(-50%);
      font-size: 13px; color: var(--text-muted); pointer-events: none;
    }
    .filter-select {
      padding: 8px 12px; border: 1px solid var(--input-border); border-radius: 20px;
      background: var(--input-bg); color: var(--text-main); font-size: 13px; outline: none; cursor: pointer;
    }

    /* BULK ACTIONS TOOLBAR */
    .bulk-toolbar {
      display: none; align-items: center; justify-content: space-between;
      background: var(--table-hover); border: 1px solid var(--border-color);
      border-radius: 8px; padding: 8px 14px; margin-bottom: 12px; flex-wrap: wrap; gap: 8px;
    }
    .bulk-toolbar.show { display: flex; }
    .bulk-toolbar-info { font-size: 13px; font-weight: 600; color: var(--text-main); display: flex; align-items: center; gap: 8px; }
    .bulk-toolbar-actions { display: flex; gap: 8px; align-items: center; }

    /* PAGINATION STYLES */
    .pagination-bar {
      display: flex; justify-content: space-between; align-items: center;
      padding: 12px 6px; font-size: 13px; color: var(--text-muted); flex-wrap: wrap; gap: 10px;
    }
    .pagination-controls { display: flex; align-items: center; gap: 6px; }
    .btn-page {
      padding: 5px 10px; border: 1px solid var(--border-color); background: var(--bg-card);
      color: var(--text-main); border-radius: 6px; font-size: 12px; cursor: pointer; font-weight: 500;
      transition: background 0.15s;
    }
    .btn-page:hover:not(:disabled) { background: var(--table-hover); }
    .btn-page:disabled { opacity: 0.4; cursor: not-allowed; }
    .page-info { font-weight: 600; font-size: 12px; padding: 0 4px; color: var(--text-main); }

    /* MODAL TABLE SỬA HÀNG LOẠT (NỔI ĐÈ LÊN) */
    .bulk-edit-modal-box {
      background: var(--bg-card); border: 1px solid var(--border-color); border-radius: 14px;
      width: 100%; max-width: 1050px; max-height: 90vh; display: flex; flex-direction: column;
      box-shadow: var(--dropdown-shadow); overflow: hidden;
    }
    .bulk-edit-modal-header {
      padding: 16px 20px; border-bottom: 1px solid var(--border-color);
      display: flex; justify-content: space-between; align-items: center;
    }
    .bulk-edit-modal-body {
      padding: 14px 20px; overflow: auto; flex: 1;
    }
    .bulk-edit-modal-footer {
      padding: 14px 20px; border-top: 1px solid var(--border-color);
      display: flex; justify-content: flex-end; gap: 10px;
    }
    .bulk-cell-input, .bulk-cell-select {
      width: 100%; min-width: 110px; padding: 6px 8px; border: 1px solid var(--input-border);
      border-radius: 6px; background: var(--input-bg); color: var(--text-main); font-size: 12.5px; outline: none;
      text-align: center;
    }
    .bulk-note, .bulk-gift-note, .bulk-cell-input.bulk-note, .bulk-cell-input.bulk-gift-note {
      text-align: left !important;
    }

    /* UPLOAD MODAL */
    .upload-dropzone {
      border: 2px dashed var(--border-color); border-radius: 10px; padding: 24px;
      text-align: center; cursor: pointer; transition: border-color 0.2s, background 0.2s;
      background: var(--table-hover); margin-bottom: 14px;
    }
    .upload-dropzone:hover { border-color: #0284c7; }
    .preview-table-container {
      max-height: 220px; overflow: auto; border: 1px solid var(--border-color); border-radius: 6px; margin-top: 10px;
    }

    /* GLOBAL ACTION LOADING OVERLAY */
    .global-action-loader {
      position: fixed; top: 0; left: 0; width: 100%; height: 100%;
      background: rgba(0, 0, 0, 0.45); backdrop-filter: blur(3px);
      display: none; align-items: center; justify-content: center;
      z-index: 10005; padding: 15px;
    }
    .action-loader-card {
      background: var(--bg-card); border: 1px solid var(--border-color);
      padding: 16px 24px; border-radius: 12px; box-shadow: var(--dropdown-shadow);
      display: flex; align-items: center; gap: 14px; max-width: 90%;
      animation: scalePop 0.2s ease;
    }
    .action-spinner {
      width: 24px; height: 24px; border: 3px solid rgba(2, 132, 199, 0.2);
      border-top-color: #0284c7; border-radius: 50%;
      animation: spinLoader 0.75s linear infinite; flex-shrink: 0;
    }
    @keyframes spinLoader {
      to { transform: rotate(360deg); }
    }
    .action-loader-text {
      font-size: 14px; font-weight: 600; color: var(--text-main);
    }

    .tab-header-row {
      display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px;
    }
    .tab-header-actions {
      display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
    }

    /* TỐI ƯU MOBILE RESPONSIVE ĐỂ KHÔNG BỊ VỠ & CÂN XỨNG */
    @media (max-width: 768px) {
      .sidebar { position: fixed; top: 0; left: 0; height: 100%; transform: translateX(-100%); box-shadow: 0 0 20px rgba(0,0,0,0.3); }
      .sidebar.open { transform: translateX(0); }
      .sidebar-backdrop.open { display: block; }
      .menu-toggle-btn { display: inline-block; }
      #closeSidebarBtn { display: inline-block !important; }
      
      .topbar { padding: 10px 12px; gap: 8px; }
      .topbar-left { flex: 1; min-width: 0; display: flex; align-items: center; gap: 8px; }
      #topbarTitle { font-size: 15px; font-weight: 700; max-width: none; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .topbar-right { gap: 6px !important; flex-shrink: 0; }
      #btnSyncData, #themeBtn { padding: 5px 8px; font-size: 12px; }
      #syncDataText, #themeBtnText { display: none; }
      
      .tab-content { padding: 10px 8px; }
      .card { padding: 14px 12px; border-radius: 10px; }
      
      /* Căn chỉnh header các Tab trên Mobile */
      .tab-header-row { flex-direction: column; align-items: stretch !important; gap: 10px !important; }
      .tab-header-actions { display: grid !important; grid-template-columns: 1fr 1fr; gap: 8px !important; width: 100%; }
      .tab-header-actions .btn, .tab-header-actions a { width: 100%; justify-content: center; text-align: center; box-sizing: border-box; }
      .tab-header-actions .btn-span-full { grid-column: span 2; }
      
      .table-container table { min-width: 820px; }
      #giftTab .table-container table { min-width: 700px; }
      #romTab .table-container table { min-width: 100%; }
      
      .filter-bar { flex-direction: column; align-items: stretch; gap: 8px; }
      .search-input-wrap { width: 100%; min-width: 100%; }
      .filter-select { width: 100%; }
      
      /* Thanh Chọn nhiều mục (Bulk Toolbar) cân đối, không lệch */
      .bulk-toolbar { flex-direction: column; align-items: stretch; gap: 10px; padding: 10px 12px; }
      .bulk-toolbar-info { display: flex; justify-content: space-between; align-items: center; width: 100%; font-size: 13px; }
      .bulk-toolbar-actions { display: flex; width: 100%; gap: 8px; }
      .bulk-toolbar-actions .btn { flex: 1; justify-content: center; text-align: center; padding: 8px 10px; font-size: 12px; min-height: 36px; }
      
      .pagination-bar { flex-direction: column; align-items: center; gap: 8px; text-align: center; }

      /* Popup Modal tối ưu trên Mobile */
      .modal-backdrop { padding: 8px; }
      .modal-box { padding: 16px 14px; border-radius: 12px; max-height: 94vh; width: 100%; box-sizing: border-box; }
      .modal-header { margin-bottom: 12px; }
      .modal-header h3 { font-size: 16px; }
      .modal-actions { display: flex !important; width: 100%; gap: 8px; justify-content: stretch !important; }
      .modal-actions .btn { flex: 1; justify-content: center; text-align: center; min-height: 38px; }
      
      /* Chi tiết thiết bị: phân bổ nút footer 2 cột cân xứng, không bị co ép chữ */
      #modalFooterView { display: grid !important; grid-template-columns: 1fr 1fr; gap: 8px; width: 100%; }
      #modalFooterView #btnSendMail { grid-column: span 2; min-height: 40px; padding: 8px 12px; }
      #modalFooterView .btn { width: 100%; min-height: 38px; justify-content: center; text-align: center; padding: 6px 10px; font-size: 13px; white-space: nowrap; }
      #modalFooterEdit { display: flex !important; gap: 8px; width: 100%; }
      #modalFooterEdit .btn { flex: 1; justify-content: center; min-height: 38px; }

      .bulk-edit-modal-box { max-height: 95vh; border-radius: 12px; width: 100%; }
      .bulk-edit-modal-header, .bulk-edit-modal-footer { padding: 12px 14px; }
      .bulk-edit-modal-footer { display: flex; gap: 8px; width: 100%; }
      .bulk-edit-modal-footer .btn { flex: 1; justify-content: center; min-height: 38px; }
      .bulk-edit-modal-body { padding: 8px; }

      .confirm-card { padding: 18px 16px; width: 100%; }
      .confirm-actions { display: flex; width: 100%; gap: 8px; }
      .confirm-actions .btn { flex: 1; justify-content: center; min-height: 38px; }
    }

    #confirmOverlay {
      position: fixed; top: 0; left: 0; width: 100%; height: 100%;
      background: var(--modal-overlay); backdrop-filter: blur(4px);
      display: none; align-items: center; justify-content: center; z-index: 10002; padding: 15px;
    }
    .confirm-card {
      background: var(--bg-card); border: 1px solid var(--border-color); border-radius: 14px;
      width: 100%; max-width: 400px; padding: 24px; box-shadow: var(--dropdown-shadow);
      text-align: center; animation: scalePop 0.2s ease;
    }
    @keyframes scalePop {
      from { transform: scale(0.92); opacity: 0; }
      to   { transform: scale(1); opacity: 1; }
    }
    .confirm-card h4 { font-size: 18px; margin-bottom: 8px; color: var(--text-main); font-weight: 700; }
    .confirm-card p { font-size: 14px; color: var(--text-muted); margin-bottom: 20px; line-height: 1.5; }
    .confirm-actions { display: flex; justify-content: center; gap: 10px; }
  </style>
</head>
<body>

  <div id="authOverlay">
    <div class="auth-card">
      <h3>Xác thực Quản Trị</h3>
      <p>Nhập mật khẩu Admin để truy cập hệ thống</p>
      <input type="password" id="authPasswordInput" placeholder="Mật khẩu Admin..." onkeyup="if(event.key==='Enter') verifyLogin()">
      <button onclick="verifyLogin()">Đăng nhập</button>
      <div id="authError" style="color: #ef4444; font-size: 13px; margin-top: 10px; display: none;"></div>
    </div>
  </div>

  <div class="sidebar-backdrop" id="sidebarBackdrop" onclick="toggleSidebar(false)"></div>

  <div class="sidebar" id="sidebar">
    <div class="brand">
      <span>MRD_Team™</span>
      <span style="font-size: 14px; cursor: pointer; color: var(--text-muted); display: none;" id="closeSidebarBtn" onclick="toggleSidebar(false)">✕</span>
    </div>
    <ul class="nav-list">
      <li class="nav-item active" onclick="switchTab('listTab', this)">📋 Danh sách Kích hoạt</li>
      <li class="nav-item" onclick="switchTab('giftTab', this)">🎁 Gift Code</li>
      <li class="nav-item" onclick="switchTab('romTab', this)">📁 Sản phẩm</li>
    </ul>
    
    <div class="sidebar-footer">
      <!-- WIDGET THỐNG KÊ QUOTA CHO PROJECT LICENSE -->
      <div class="quota-box" id="licenseQuotaBox">
        <div class="quota-title">
          <span>LICENSE REQ CÒN LẠI</span>
          <span id="quotaPercent">100%</span>
        </div>
        <div class="quota-number" id="quotaRemainingText">50,000 / 50,000</div>
        <div class="quota-sub" id="quotaUsedText">Đã dùng hôm nay: 0 req</div>
        <div class="quota-bar-bg">
          <div class="quota-bar-fill" id="quotaProgress" style="width: 100%;"></div>
        </div>
      </div>

      <button class="btn-logout" onclick="logout()">🔒 Khóa màn hình</button>
    </div>
  </div>

  <div id="toastContainer"></div>

  <!-- GLOBAL ACTION LOADING OVERLAY -->
  <div id="globalActionLoader" class="global-action-loader">
    <div class="action-loader-card">
      <div class="action-spinner"></div>
      <div class="action-loader-text" id="actionLoaderText">Đang xử lý yêu cầu...</div>
    </div>
  </div>

  <div id="confirmOverlay">
    <div class="confirm-card">
      <h4 id="confirmTitle">Xác nhận</h4>
      <p id="confirmDesc">Bạn có chắc chắn muốn thực hiện thao tác này?</p>
      <div class="confirm-actions">
        <button class="btn btn-gray" id="btnCancelConfirm">Hủy</button>
        <button class="btn btn-red" id="btnAcceptConfirm">Đồng ý</button>
      </div>
    </div>
  </div>

  <div class="content-area">
    <div class="topbar">
      <div class="topbar-left">
        <button class="menu-toggle-btn" onclick="toggleSidebar(true)">☰</button>
        <div style="font-size: 17px; font-weight: bold;" id="topbarTitle">Quản lý Kích hoạt</div>
      </div>
      <div class="topbar-right" style="display: flex; align-items: center; gap: 8px;">
        <button class="theme-toggle-btn" id="btnSyncData" onclick="manualSyncData()" title="Đồng bộ dữ liệu mới nhất từ máy chủ">
          <span id="syncDataIcon" class="sync-icon">🔄</span>
          <span id="syncDataText">Đồng bộ dữ liệu</span>
        </button>
        <div class="theme-dropdown-container">
          <button class="theme-toggle-btn" id="themeBtn" onclick="toggleThemeDropdown(event)" title="Chọn giao diện">
            <span id="themeBtnIcon">🌙</span>
            <span id="themeBtnText">Giao diện</span>
          </button>
          <div class="theme-dropdown-menu" id="themeDropdownMenu">
            <div class="theme-dropdown-header">Giao diện</div>
            <div class="theme-dropdown-item" id="themeOpt-light" onclick="setThemeMode('light')">
              <span>☀️ Sáng</span>
              <span class="theme-check"></span>
            </div>
            <div class="theme-dropdown-item" id="themeOpt-dark" onclick="setThemeMode('dark')">
              <span>🌙 Tối</span>
              <span class="theme-check"></span>
            </div>
            <div class="theme-dropdown-item" id="themeOpt-system" onclick="setThemeMode('system')">
              <span>💻 Hệ thống</span>
              <span class="theme-check"></span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- TAB 1: DANH SÁCH -->
    <div id="listTab" class="tab-content active">
      <div class="card" style="margin-bottom: 20px;">
        <div class="tab-header-row">
          <div>
            <h3 style="margin: 0; font-size: 16px;">📱 Danh sách Kích hoạt</h3>
          </div>
          <div class="tab-header-actions">
            <button type="button" class="btn btn-green" id="btnUploadLicense" style="padding: 7px 14px; font-size: 12px;" onclick="openUploadModal('license')" title="Tải lên tệp Excel danh sách kích hoạt">📥 Upload Excel</button>
            <button type="button" class="btn btn-blue" id="btnSyncShards" style="padding: 7px 14px; font-size: 12px;" onclick="handleSyncAllPrefixes()" title="Tính toán lại Prefix và đồng bộ cache phân mảnh">🔄 Đồng bộ Shards</button>
            <button type="button" class="btn btn-green btn-span-full" style="padding: 7px 14px; font-size: 12px;" onclick="openCreateLicenseModal()">+ Thêm mới</button>
          </div>
        </div>
      </div>

      <div class="card">
        <!-- FILTER BAR -->
        <div class="filter-bar">
          <div class="search-input-wrap">
            <span class="search-icon">🔍</span>
            <input type="text" id="licenseSearchInput" placeholder="Tìm kiếm Serial, Phiên bản, Email/SĐT, Ghi chú..." oninput="onLicenseSearchChange()">
          </div>
          <select class="filter-select" id="licenseStatusFilter" onchange="onLicenseSearchChange()">
            <option value="">-- Tất cả trạng thái --</option>
            <option value="OK">OK (Kích hoạt)</option>
            <option value="DEL">DEL (Xóa)</option>
          </select>
          <select class="filter-select" id="licenseRomFilter" onchange="onLicenseSearchChange()">
            <option value="">-- Tất cả sản phẩm --</option>
          </select>
        </div>

        <!-- BULK TOOLBAR -->
        <div class="bulk-toolbar" id="licenseBulkToolbar">
          <div class="bulk-toolbar-info">
            <span id="licenseBulkCountText">Đã chọn 0 mục</span>
            <button type="button" class="btn btn-gray" style="padding: 3px 8px; font-size: 11px;" onclick="clearLicenseSelection()">Bỏ chọn</button>
          </div>
          <div class="bulk-toolbar-actions">
            <button type="button" class="btn btn-blue" style="padding: 6px 12px; font-size: 12px;" onclick="openBulkEditLicenseModal()">✏️ Sửa đã chọn</button>
            <button type="button" class="btn btn-red" id="btnBulkDeleteLicense" style="padding: 6px 12px; font-size: 12px;" onclick="handleBulkDeleteLicenses()">🗑️ Xóa đã chọn</button>
          </div>
        </div>

        <div class="table-container">
          <table>
            <thead>
              <tr>
                <th class="col-cb">
                  <input type="checkbox" id="checkAllLicenses" onchange="toggleSelectAllLicenses(this.checked)">
                </th>
                <th class="col-stt">STT</th>
                <th style="width: 140px;">SERIAL</th>
                <th style="width: 130px;">PHIÊN BẢN</th>
                <th style="width: 105px;">TRẠNG THÁI KEY</th>
                <th style="width: 180px;">EMAIL/SĐT</th>
                <th style="width: 80px;">QUỐC GIA</th>
                <th style="width: 85px;">GỬI MAIL</th>
                <th style="width: 130px;">JSON</th>
                <th class="col-note">GHI CHÚ</th>
              </tr>
            </thead>
            <tbody id="licenseTableBody">
              <tr><td colspan="10" style="text-align: center; color: var(--text-muted);">Đang tải dữ liệu...</td></tr>
            </tbody>
          </table>
        </div>

        <!-- PAGINATION -->
        <div class="pagination-bar" id="licensePagination"></div>
      </div>
    </div>


    <!-- TAB 3: DANH MỤC SẢN PHẨM -->
    <div id="romTab" class="tab-content">
      <div class="card" style="max-width: 650px; margin: 0 auto 20px auto;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; flex-wrap: wrap; gap: 8px;">
          <h4 style="margin: 0;">Thêm Sản phẩm</h4>
          <button class="btn btn-green" style="padding: 5px 12px; font-size: 12px;" onclick="openUploadModal('rom')">📥 Upload Excel</button>
        </div>
        <div style="display: flex; gap: 8px;">
          <input type="text" id="newRomName" placeholder="Tên Sản phẩm mới..." style="flex: 1; padding: 10px; border: 1px solid var(--border-color); border-radius: 6px; background: var(--bg-body); color: var(--text-main);">
          <button class="btn btn-blue" id="btnAddRom" onclick="handleAddRom()">+ Thêm</button>
        </div>
      </div>

      <div class="card" style="max-width: 650px; margin: auto;">
        <div class="filter-bar" style="margin-bottom: 12px;">
          <div class="search-input-wrap">
            <span class="search-icon">🔍</span>
            <input type="text" id="romSearchInput" placeholder="Tìm kiếm Sản phẩm..." oninput="onRomSearchChange()">
          </div>
        </div>
        <div class="table-container">
          <table>
            <thead><tr><th>Tên Sản phẩm</th><th style="width: 80px; text-align: center;">Hành động</th></tr></thead>
            <tbody id="romTableBody"></tbody>
          </table>
        </div>
        <!-- PAGINATION -->
        <div class="pagination-bar" id="romPagination"></div>
      </div>
    </div>

    <!-- TAB 4: QUẢN LÝ GIFT CODE -->
    <div id="giftTab" class="tab-content">
      <div class="card" style="margin-bottom: 20px;">
        <div class="tab-header-row">
          <div>
            <h3 style="margin: 0; font-size: 16px;">🎁 Danh sách Gift Code</h3>
          </div>
          <div class="tab-header-actions">
            <a id="giftShardBadgeLink" href="/json/giftcode.json" target="_blank" title="Mở file JSON RAW trên GitHub Repo" style="text-decoration:none;">
              <span class="badge badge-shard" style="padding: 7px 14px; font-size: 12px; display: inline-flex; align-items: center; justify-content: center; gap: 4px; cursor: pointer; width: 100%;">🚀 json/giftcode.json</span>
            </a>
            <button class="btn btn-green" style="padding: 7px 14px; font-size: 12px;" onclick="openCreateGiftModal()">+ Tạo Gift Code</button>
          </div>
        </div>
      </div>

      <div class="card">
        <!-- FILTER BAR -->
        <div class="filter-bar">
          <div class="search-input-wrap">
            <span class="search-icon">🔍</span>
            <input type="text" id="giftSearchInput" placeholder="Tìm kiếm Gift Code, Ghi chú..." oninput="onGiftSearchChange()">
          </div>
          <select class="filter-select" id="giftStatusFilter" onchange="onGiftSearchChange()">
            <option value="">-- Tất cả trạng thái --</option>
            <option value="ACTIVE">OK (Còn hạn)</option>
            <option value="EXPIRED">BLOCK (Hết hạn)</option>
          </select>
        </div>

        <!-- BULK TOOLBAR -->
        <div class="bulk-toolbar" id="giftBulkToolbar">
          <div class="bulk-toolbar-info">
            <span id="giftBulkCountText">Đã chọn 0 mục</span>
            <button type="button" class="btn btn-gray" style="padding: 3px 8px; font-size: 11px;" onclick="clearGiftSelection()">Bỏ chọn</button>
          </div>
          <div class="bulk-toolbar-actions">
            <button type="button" class="btn btn-blue" style="padding: 6px 12px; font-size: 12px;" onclick="openBulkEditGiftModal()">✏️ Sửa đã chọn</button>
            <button type="button" class="btn btn-red" id="btnBulkDeleteGift" style="padding: 6px 12px; font-size: 12px;" onclick="handleBulkDeleteGifts()">🗑️ Xóa đã chọn</button>
          </div>
        </div>

        <div class="table-container">
          <table>
            <thead>
              <tr>
                <th class="col-cb">
                  <input type="checkbox" id="checkAllGifts" onchange="toggleSelectAllGifts(this.checked)">
                </th>
                <th class="col-stt">STT</th>
                <th style="width: 180px;">GIFT CODE</th>
                <th style="width: 120px;">NGÀY TẠO</th>
                <th style="width: 120px;">NGÀY HẾT HẠN</th>
                <th style="width: 110px;">TRẠNG THÁI KEY</th>
                <th class="col-note">GHI CHÚ</th>
                <th class="col-actions">HÀNH ĐỘNG</th>
              </tr>
            </thead>
            <tbody id="giftTableBody">
              <tr><td colspan="8" style="text-align: center; color: var(--text-muted);">Đang tải dữ liệu Gift Code...</td></tr>
            </tbody>
          </table>
        </div>

        <!-- PAGINATION -->
        <div class="pagination-bar" id="giftPagination"></div>
      </div>
    </div>
  </div>

  <!-- MODAL BẢNG SỬA NỔI HÀNG LOẠT (KÍCH HOẠT) -->
  <div class="modal-backdrop" id="bulkEditLicenseModal">
    <div class="bulk-edit-modal-box">
      <div class="bulk-edit-modal-header">
        <h3 style="font-size: 16px; margin: 0;">✏️ Chỉnh sửa hàng loạt Danh sách Kích hoạt</h3>
        <span class="close-btn" onclick="closeBulkEditLicenseModal()">&times;</span>
      </div>
      <div class="bulk-edit-modal-body">
        <div class="table-container">
          <table style="min-width: 900px;">
            <thead>
              <tr>
                <th style="width: 40px;">STT</th>
                <th>SERIAL (*)</th>
                <th>PHIÊN BẢN (*)</th>
                <th>TRẠNG THÁI KEY</th>
                <th>EMAIL/SĐT</th>
                <th>QUỐC GIA</th>
                <th>GỬI MAIL</th>
                <th class="col-note">GHI CHÚ</th>
              </tr>
            </thead>
            <tbody id="bulkEditLicenseTbody"></tbody>
          </table>
        </div>
      </div>
      <div class="bulk-edit-modal-footer">
        <button type="button" class="btn btn-gray" onclick="closeBulkEditLicenseModal()">Hủy</button>
        <button type="button" class="btn btn-green" id="btnSaveBulkLicenses" onclick="saveBulkEditLicenses()">Lưu</button>
      </div>
    </div>
  </div>

  <!-- MODAL BẢNG SỬA NỔI HÀNG LOẠT (GIFT CODE) -->
  <div class="modal-backdrop" id="bulkEditGiftModal">
    <div class="bulk-edit-modal-box" style="max-width: 850px;">
      <div class="bulk-edit-modal-header">
        <h3 style="font-size: 16px; margin: 0;">✏️ Chỉnh sửa hàng loạt Gift Code</h3>
        <span class="close-btn" onclick="closeBulkEditGiftModal()">&times;</span>
      </div>
      <div class="bulk-edit-modal-body">
        <div class="table-container">
          <table style="min-width: 750px;">
            <thead>
              <tr>
                <th style="width: 40px;">STT</th>
                <th>GIFT CODE (*)</th>
                <th>NGÀY TẠO (YYYY-MM-DD) (*)</th>
                <th>NGÀY HẾT HẠN (YYYY-MM-DD) (*)</th>
                <th class="col-note">GHI CHÚ</th>
              </tr>
            </thead>
            <tbody id="bulkEditGiftTbody"></tbody>
          </table>
        </div>
      </div>
      <div class="bulk-edit-modal-footer">
        <button type="button" class="btn btn-gray" onclick="closeBulkEditGiftModal()">Hủy</button>
        <button type="button" class="btn btn-green" id="btnSaveBulkGifts" onclick="saveBulkEditGifts()">Lưu</button>
      </div>
    </div>
  </div>

  <!-- MODAL UPLOAD EXCEL (DÙNG CHUNG CHO KÍCH HOẠT VÀ SẢN PHẨM) -->
  <div class="modal-backdrop" id="uploadExcelModal">
    <div class="modal-box" style="max-width: 700px;">
      <div class="modal-header">
        <h3 id="uploadModalTitle">📥 Tải lên tệp Excel</h3>
        <span class="close-btn" onclick="closeUploadModal()">&times;</span>
      </div>
      
      <div style="font-size: 13px; color: var(--text-muted); margin-bottom: 12px;" id="uploadModalDesc">
        Chọn file Excel (.xlsx, .xls) hoặc .csv để nhập danh sách vào hệ thống.
      </div>

      <div class="upload-dropzone" onclick="document.getElementById('excelFileInput').click()">
        <input type="file" id="excelFileInput" accept=".xlsx,.xls,.csv" style="display: none;" onchange="handleExcelFileSelected(event)">
        <div style="font-size: 32px; margin-bottom: 8px;">📊</div>
        <div style="font-weight: 600; font-size: 14px; margin-bottom: 4px;" id="uploadFileNameText">Nhấp để chọn tệp Excel hoặc kéo thả vào đây</div>
        <div style="font-size: 12px; color: var(--text-muted);">Hỗ trợ định dạng: .xlsx, .xls, .csv</div>
      </div>

      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
        <span style="font-size: 12px; font-weight: 600;" id="uploadPreviewTitle">Xem trước dữ liệu:</span>
        <button type="button" class="btn btn-gray" style="padding: 4px 8px; font-size: 11px;" onclick="downloadSampleExcel()">📥 Tải file mẫu (.xlsx)</button>
      </div>

      <div class="preview-table-container">
        <table id="uploadPreviewTable">
          <thead></thead>
          <tbody>
            <tr><td style="text-align: center; color: var(--text-muted); padding: 16px;">Chưa chọn tệp tin nào.</td></tr>
          </tbody>
        </table>
      </div>

      <div style="margin-top: 10px; font-size: 12px; font-weight: 600; color: #0284c7;" id="uploadSummaryText"></div>

      <div class="modal-footer" style="margin-top: 16px;">
        <button type="button" class="btn btn-gray" onclick="closeUploadModal()">Hủy</button>
        <button type="button" class="btn btn-green" id="btnConfirmUpload" disabled onclick="executeBulkImport()">Nhập dữ liệu</button>
      </div>
    </div>
  </div>
  </div>

  <!-- MODAL TẠO KÍCH HOẠT MỚI -->
  <div class="modal-backdrop" id="createLicenseModal">
    <div class="modal-box" style="max-width: 520px;">
      <div class="modal-header">
        <h3 id="createLicenseModalTitle">➕ Thêm Kích hoạt Mới</h3>
        <span class="close-btn" onclick="closeCreateLicenseModal()">&times;</span>
      </div>
      
      <div class="form-group">
        <label>SERIAL (*)</label>
        <input type="text" id="addSerial" placeholder="Ví dụ: G6AY8400E7W">
      </div>
      <div class="form-group">
        <label>PHIÊN BẢN (*)</label>
        <select id="addRomSelect"></select>
      </div>
      <div class="form-group">
        <label>TRẠNG THÁI KEY</label>
        <select id="addStatus">
          <option value="OK">OK (Kích hoạt)</option>
          <option value="DEL">DEL (Xóa)</option>
        </select>
      </div>
      <div class="form-group">
        <label>EMAIL/SĐT</label>
        <input type="text" id="addEmail" placeholder="Nhập Email hoặc SĐT khách">
      </div>
      <div class="form-group">
        <label>QUỐC GIA</label>
        <select id="addCountry">
          <option value="VN">VN (Gửi mail tiếng Việt)</option>
          <option value="Other">Other (Gửi mail tiếng Anh)</option>
        </select>
      </div>
      <div class="form-group">
        <label>GHI CHÚ</label>
        <input type="text" id="addNote" placeholder="Ghi chú thiết bị/khách hàng">
      </div>

      <div class="modal-actions" style="margin-top: 20px; display: flex; justify-content: flex-end; gap: 10px;">
        <button class="btn btn-gray" onclick="closeCreateLicenseModal()">Hủy</button>
        <button class="btn btn-green" id="btnSaveNewLicense" onclick="handleCreateLicense()">+ Thêm Kích hoạt</button>
      </div>
    </div>
  </div>

  <!-- MODAL TẠO / SỬA GIFT CODE -->
  <div class="modal-backdrop" id="giftModal">
    <div class="modal-box" style="max-width: 500px;">
      <div class="modal-header">
        <h3 id="giftModalTitle">Tạo Gift Code Mới</h3>
        <span class="close-btn" onclick="closeGiftModal()">&times;</span>
      </div>
      
      <input type="hidden" id="giftId">
      <div class="form-group">
        <label>GIFT CODE (*)</label>
        <div style="display: flex; gap: 8px;">
          <input type="text" id="giftCodeInput" placeholder="Ví dụ: VIP2026XYZ" style="flex: 1;">
          <button type="button" class="btn btn-gray" style="white-space: nowrap; font-size: 12px; padding: 0 10px;" onclick="generateRandomGiftCode()">🎲 Tạo mã</button>
        </div>
      </div>
      <div class="form-group">
        <label>NGÀY TẠO (YYYY-MM-DD) (*)</label>
        <input type="date" id="giftStartDate">
      </div>
      <div class="form-group">
        <label>NGÀY HẾT HẠN (YYYY-MM-DD) (*)</label>
        <input type="date" id="giftExpDate">
      </div>
      <div class="form-group">
        <label>GHI CHÚ</label>
        <input type="text" id="giftNote" placeholder="Ghi chú người nhận hoặc sự kiện...">
      </div>
      
      <div class="modal-actions" style="margin-top: 20px; display: flex; justify-content: flex-end; gap: 10px;">
        <button class="btn btn-gray" onclick="closeGiftModal()">Hủy</button>
        <button class="btn btn-green" id="btnSaveGift" onclick="handleSaveGiftKey()">Lưu</button>
      </div>
    </div>
  </div>

  <!-- MODAL CHI TIẾT -->
  <div class="modal-backdrop" id="detailModal">
    <div class="modal-box">
      <div class="modal-header">
        <h3 id="modalTitle">Chi tiết Thiết bị</h3>
        <span class="close-btn" onclick="closeModal()">&times;</span>
      </div>
      
      <input type="hidden" id="editId">
      <div class="form-group">
        <label>JSON RAW</label>
        <div>
          <a id="editPrefixLink" href="#" target="_blank" class="btn btn-blue" style="display: inline-flex; align-items: center; gap: 8px; text-decoration: none; font-family: monospace; font-size: 13px; font-weight: 600; padding: 8px 16px; border-radius: 6px;" title="Mở file JSON RAW">
            <span>🚀</span>
            <span id="editPrefixText">json/unk.json</span>
            <span style="font-size: 11px; opacity: 0.85;">↗</span>
          </a>
        </div>
      </div>
      <div class="form-group">
        <label>SERIAL</label>
        <input type="text" id="editSerial" disabled>
      </div>
      <div class="form-group">
        <label>PHIÊN BẢN</label>
        <select id="editRomSelect" disabled></select>
      </div>
      <div class="form-group">
        <label>TRẠNG THÁI KEY</label>
        <select id="editStatus" disabled>
          <option value="OK">OK (Kích hoạt)</option>
          <option value="DEL">DEL (Xóa)</option>
        </select>
      </div>
      <div class="form-group">
        <label>EMAIL/SĐT</label>
        <input type="text" id="editEmail" disabled>
      </div>
      <div class="form-group">
        <label>QUỐC GIA</label>
        <select id="editCountry" disabled>
          <option value="VN">VN</option>
          <option value="Other">Other</option>
        </select>
      </div>
      <div class="form-group">
        <label>GHI CHÚ</label>
        <input type="text" id="editNote" disabled>
      </div>

      <div class="modal-footer" id="modalFooterView">
        <button type="button" class="btn btn-blue" id="btnSendMail" onclick="handleResendMailFromModal(this)">Gửi Email kích hoạt</button>
        <button type="button" class="btn btn-blue" id="btnEditKey" onclick="toggleEditMode(true)">Chỉnh sửa</button>
        <button type="button" class="btn btn-red" id="btnDeleteKey" onclick="handleDeleteFromModal()">Xóa</button>
        <button type="button" class="btn btn-gray" onclick="closeModal()">Đóng</button>
      </div>
      <div class="modal-footer" id="modalFooterEdit" style="display: none;">
        <button type="button" class="btn btn-green" id="btnSaveEdit" onclick="handleSaveEdit()">Lưu</button>
        <button type="button" class="btn btn-gray" onclick="toggleEditMode(false)">Hủy</button>
      </div>
    </div>
  </div>

  <script>
    let currentAuthToken = "";
    let systemData = { licenses: [], rom_categories: [], gift_keys: [] };
    let currentSelectedItem = null;

    // Phân trang & Tìm kiếm & Bulk Selection & Excel State
    const PAGE_SIZE = 10;
    let licensePage = 1;
    let giftPage = 1;
    let romPage = 1;

    let licenseSearchText = "";
    let licenseStatusFilter = "";
    let licenseRomFilter = "";
    let giftSearchText = "";
    let giftStatusFilter = "";
    let romSearchText = "";

    let selectedLicenseIds = new Set();
    let selectedGiftIds = new Set();

    let currentUploadType = "license";
    let parsedImportData = [];

    function showActionLoader(text) {
      const loader = document.getElementById("globalActionLoader");
      const textEl = document.getElementById("actionLoaderText");
      if (textEl && text) textEl.innerText = text;
      if (loader) loader.style.display = "flex";
    }

    function hideActionLoader() {
      const loader = document.getElementById("globalActionLoader");
      if (loader) loader.style.display = "none";
    }

    function setBtnLoading(btn, isLoading, loadingText) {
      if (!btn) return;
      if (isLoading) {
        if (!btn.dataset.origHtml) btn.dataset.origHtml = btn.innerHTML;
        btn.disabled = true;
        btn.classList.add("loading");
        btn.innerHTML = '<span class="btn-spinner"></span> ' + (loadingText || "Đang xử lý...");
      } else {
        btn.disabled = false;
        btn.classList.remove("loading");
        if (btn.dataset.origHtml) {
          btn.innerHTML = btn.dataset.origHtml;
          delete btn.dataset.origHtml;
        }
      }
    }

    function showToast(message, type = "info", duration = 4000) {
      const container = document.getElementById("toastContainer");
      const toast = document.createElement("div");
      toast.className = "toast-msg toast-" + type;

      const icons = { success: "✅", error: "❌", warn: "⚠️", info: "ℹ️" };
      const iconChar = icons[type] || "ℹ️";
      toast.innerHTML = "<span>" + iconChar + "</span><div style='flex:1;'>" + message + "</div>";
      container.appendChild(toast);

      setTimeout(() => { toast.remove(); }, duration);
    }

    function showConfirm(title, message, isDanger = false) {
      return new Promise((resolve) => {
        const overlay = document.getElementById("confirmOverlay");
        const titleEl = document.getElementById("confirmTitle");
        const descEl = document.getElementById("confirmDesc");
        const acceptBtn = document.getElementById("btnAcceptConfirm");
        const cancelBtn = document.getElementById("btnCancelConfirm");

        if (!overlay || !titleEl || !descEl || !acceptBtn || !cancelBtn) {
          return resolve(confirm(message));
        }

        titleEl.innerText = title;
        descEl.innerText = message;
        acceptBtn.className = isDanger ? "btn btn-red" : "btn btn-blue";
        overlay.style.display = "flex";

        function cleanup(result) {
          overlay.style.display = "none";
          acceptBtn.onclick = null;
          cancelBtn.onclick = null;
          resolve(result);
        }

        acceptBtn.onclick = () => cleanup(true);
        cancelBtn.onclick = () => cleanup(false);
      });
    }

    let currentThemeMode = localStorage.getItem("mrd_theme_mode") || "system";

    function applyResolvedTheme() {
      let resolvedTheme = currentThemeMode;
      if (currentThemeMode === "system") {
        resolvedTheme = (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) ? "dark" : "light";
      }
      document.documentElement.setAttribute("data-theme", resolvedTheme);

      const iconEl = document.getElementById("themeBtnIcon");
      if (iconEl) iconEl.innerText = resolvedTheme === "dark" ? "🌙" : "☀️";

      ["light", "dark", "system"].forEach(function(m) {
        const item = document.getElementById("themeOpt-" + m);
        if (item) {
          const checkEl = item.querySelector(".theme-check");
          if (m === currentThemeMode) {
            item.classList.add("active");
            if (checkEl) checkEl.innerText = "✓";
          } else {
            item.classList.remove("active");
            if (checkEl) checkEl.innerText = "";
          }
        }
      });
    }

    function setThemeMode(mode) {
      currentThemeMode = mode;
      localStorage.setItem("mrd_theme_mode", mode);
      applyResolvedTheme();
      toggleThemeDropdown(null, false);
    }

    function toggleThemeDropdown(e, forceState) {
      if (e) e.stopPropagation();
      const menu = document.getElementById("themeDropdownMenu");
      if (!menu) return;
      if (forceState !== undefined) {
        if (forceState) menu.classList.add("show");
        else menu.classList.remove("show");
      } else {
        menu.classList.toggle("show");
      }
    }

    document.addEventListener("click", function() {
      toggleThemeDropdown(null, false);
    });

    if (window.matchMedia) {
      window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", function() {
        if (currentThemeMode === "system") applyResolvedTheme();
      });
    }

    applyResolvedTheme();

    function toggleSidebar(open) {
      const sidebar = document.getElementById("sidebar");
      const backdrop = document.getElementById("sidebarBackdrop");
      const closeBtn = document.getElementById("closeSidebarBtn");
      if (open) {
        sidebar.classList.add("open");
        backdrop.classList.add("open");
        closeBtn.style.display = "inline-block";
      } else {
        sidebar.classList.remove("open");
        backdrop.classList.remove("open");
        closeBtn.style.display = "none";
      }
    }

    function switchTab(tabId, el) {
      document.querySelectorAll(".tab-content").forEach(t => t.classList.remove("active"));
      document.querySelectorAll(".nav-item").forEach(n => n.classList.remove("active"));
      document.getElementById(tabId).classList.add("active");
      el.classList.add("active");

      const titles = {
        listTab: "Danh sách Kích hoạt",
        giftTab: "Quản lý Gift Code",
        romTab: "Quản lý Sản phẩm"
      };
      document.getElementById("topbarTitle").innerText = titles[tabId] || "";

      if (window.innerWidth <= 768) toggleSidebar(false);
    }

    /**
     * Nút bấm Đồng bộ dữ liệu thủ công trên Topbar (phát sinh đúng 1 request thực tế)
     */
    async function manualSyncData() {
      const icon = document.getElementById("syncDataIcon");
      const btn = document.getElementById("btnSyncData");
      if (btn) btn.disabled = true;
      if (icon) icon.classList.add("spinning");
      try {
        await loadAllData();
        showToast("Đã đồng bộ dữ liệu mới nhất thành công!", "success");
      } catch (err) {
        showToast("Lỗi đồng bộ dữ liệu: " + err.message, "error");
      } finally {
        if (icon) icon.classList.remove("spinning");
        if (btn) btn.disabled = false;
      }
    }

    async function verifyLogin() {
      const pwd = document.getElementById("authPasswordInput").value.trim();
      const errEl = document.getElementById("authError");
      const btn = document.querySelector("#authOverlay button");
      errEl.style.display = "none";

      if (!pwd) {
        errEl.innerText = "Vui lòng nhập mật khẩu!";
        errEl.style.display = "block";
        return;
      }

      if (btn) {
        btn.disabled = true;
        btn.innerText = "⏳ Đang kiểm tra...";
      }

      try {
        const res = await fetch("/api/admin/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ password: pwd })
        });

        let data = {};
        try { data = await res.json(); } catch(e) {}

        if (res.ok) {
          currentAuthToken = pwd;
          document.getElementById("authOverlay").style.display = "none";
          await loadAllData();
        } else {
          errEl.innerText = data.message || "Mật khẩu không chính xác!";
          errEl.style.display = "block";
        }
      } catch (err) {
        errEl.innerText = "Lỗi kết nối máy chủ: " + err.message;
        errEl.style.display = "block";
      } finally {
        if (btn) {
          btn.disabled = false;
          btn.innerText = "Đăng nhập";
        }
      }
    }

    function logout() {
      currentAuthToken = "";
      document.getElementById("authPasswordInput").value = "";
      document.getElementById("authOverlay").style.display = "flex";
      if (window.innerWidth <= 768) toggleSidebar(false);
    }

    async function loadAllData() {
      try {
        const res = await fetch("/api/admin/init-data", {
          headers: { "Authorization": "Bearer " + currentAuthToken }
        });
        if (res.status === 401) return logout();

        systemData = await res.json();
        if (systemData.error) {
          showToast(systemData.error, "warn");
        }
        renderLicenseTable();
        renderRomDropdowns();
        renderRomTable();
        renderGiftTable();

      // CẬP NHẬT WIDGET ĐẾM REQUEST LICENSE
      if (systemData.license_quota) {
        const q = systemData.license_quota;
        const exactPercent = (q.remaining / q.limit) * 100;
        let displayPercent = exactPercent.toFixed(1);
        if (q.used > 0 && exactPercent > 99.9) {
          displayPercent = "99.9";
        } else if (exactPercent >= 100 || q.used === 0) {
          displayPercent = "100";
        }
        
        document.getElementById("quotaRemainingText").innerText = 
          q.remaining.toLocaleString() + " / " + q.limit.toLocaleString();
        document.getElementById("quotaPercent").innerText = displayPercent + "%";
        document.getElementById("quotaUsedText").innerText = 
          "Đã dùng hôm nay: " + q.used.toLocaleString() + " req";
        
        const bar = document.getElementById("quotaProgress");
        bar.style.width = Math.min(100, Math.max(0, exactPercent)).toFixed(2) + "%";
        
        if (exactPercent <= 20) {
          bar.style.background = "#ef4444";
        } else if (exactPercent <= 50) {
          bar.style.background = "#f59e0b";
        } else {
          bar.style.background = "#38bdf8";
        }
      }
    } catch (err) {
      showToast("Lỗi tải dữ liệu: " + err.message, "error");
    }
  }

    function getGithubFileUrl(filePath) {
      let cleanRepo = (systemData.github_repo || "").trim();
      if (cleanRepo.indexOf("github.com/") !== -1) {
        cleanRepo = cleanRepo.split("github.com/")[1];
      }
      while (cleanRepo.startsWith("/")) cleanRepo = cleanRepo.slice(1);
      while (cleanRepo.endsWith("/")) cleanRepo = cleanRepo.slice(0, -1);
      if (cleanRepo.endsWith(".git")) cleanRepo = cleanRepo.slice(0, -4);

      if (!cleanRepo) {
        const rawDomain = systemData.pages_domain || "";
        const pagesBase = rawDomain.endsWith("/") ? rawDomain.slice(0, -1) : rawDomain;
        return pagesBase ? (pagesBase + "/" + filePath) : ("/" + filePath);
      }
      return "https://raw.githubusercontent.com/" + cleanRepo + "/main/" + filePath;
    }

    function onLicenseSearchChange() {
      const input = document.getElementById("licenseSearchInput");
      const status = document.getElementById("licenseStatusFilter");
      const rom = document.getElementById("licenseRomFilter");
      licenseSearchText = (input ? input.value : "").trim().toLowerCase();
      licenseStatusFilter = status ? status.value : "";
      licenseRomFilter = rom ? rom.value : "";
      licensePage = 1;
      renderLicenseTable();
    }

    function onGiftSearchChange() {
      const input = document.getElementById("giftSearchInput");
      const status = document.getElementById("giftStatusFilter");
      giftSearchText = (input ? input.value : "").trim().toLowerCase();
      giftStatusFilter = status ? status.value : "";
      giftPage = 1;
      renderGiftTable();
    }

    function onRomSearchChange() {
      const input = document.getElementById("romSearchInput");
      romSearchText = (input ? input.value : "").trim().toLowerCase();
      romPage = 1;
      renderRomTable();
    }

    function getFilteredLicenses() {
      const list = systemData.licenses || [];
      return list.filter(function(item) {
        if (licenseStatusFilter && item.key_status !== licenseStatusFilter) return false;
        if (licenseRomFilter && item.rom_version !== licenseRomFilter) return false;
        if (licenseSearchText) {
          const serial = (item.serial || "").toLowerCase();
          const rom = (item.rom_version || "").toLowerCase();
          const email = (item.email_phone || "").toLowerCase();
          const note = (item.note || "").toLowerCase();
          const prefix = (item.prefix || "").toLowerCase();
          const match = serial.indexOf(licenseSearchText) !== -1 ||
                        rom.indexOf(licenseSearchText) !== -1 ||
                        email.indexOf(licenseSearchText) !== -1 ||
                        note.indexOf(licenseSearchText) !== -1 ||
                        prefix.indexOf(licenseSearchText) !== -1;
          if (!match) return false;
        }
        return true;
      });
    }

    function getFilteredGifts() {
      const list = systemData.gift_keys || [];
      const todayStr = new Date().toISOString().split("T")[0];
      return list.filter(function(item) {
        const isExpired = (item.expiration_date || "") < todayStr;
        if (giftStatusFilter === "ACTIVE" && isExpired) return false;
        if (giftStatusFilter === "EXPIRED" && !isExpired) return false;
        if (giftSearchText) {
          const code = (item.gift_code || "").toLowerCase();
          const note = (item.note || "").toLowerCase();
          const match = code.indexOf(giftSearchText) !== -1 || note.indexOf(giftSearchText) !== -1;
          if (!match) return false;
        }
        return true;
      });
    }

    function getFilteredRoms() {
      const list = systemData.rom_categories || [];
      return list.filter(function(name) {
        if (!romSearchText) return true;
        return name.toLowerCase().indexOf(romSearchText) !== -1;
      });
    }

    function renderPaginationUI(containerId, currentPage, totalPages, totalCount, onPageFnName) {
      const container = document.getElementById(containerId);
      if (!container) return;
      if (totalCount === 0) {
        container.innerHTML = "";
        return;
      }

      let html = '<div class="page-info">Trang ' + currentPage + ' / ' + totalPages + ' (Tổng cộng ' + totalCount + ' mục)</div>';
      html += '<div class="pagination-controls">';
      html += '<button type="button" class="btn-page" ' + (currentPage <= 1 ? 'disabled' : '') + ' onclick="' + onPageFnName + '(1)">« Đầu</button>';
      html += '<button type="button" class="btn-page" ' + (currentPage <= 1 ? 'disabled' : '') + ' onclick="' + onPageFnName + '(' + (currentPage - 1) + ')">‹ Trước</button>';

      const startPage = Math.max(1, currentPage - 2);
      const endPage = Math.min(totalPages, currentPage + 2);

      for (let p = startPage; p <= endPage; p++) {
        const activeStyle = (p === currentPage) ? ' style="background:#0284c7; color:#fff; font-weight:bold; border-color:#0284c7;"' : '';
        html += '<button type="button" class="btn-page"' + activeStyle + ' onclick="' + onPageFnName + '(' + p + ')">' + p + '</button>';
      }

      html += '<button type="button" class="btn-page" ' + (currentPage >= totalPages ? 'disabled' : '') + ' onclick="' + onPageFnName + '(' + (currentPage + 1) + ')">Sau ›</button>';
      html += '<button type="button" class="btn-page" ' + (currentPage >= totalPages ? 'disabled' : '') + ' onclick="' + onPageFnName + '(' + totalPages + ')">Cuối »</button>';
      html += '</div>';

      container.innerHTML = html;
    }

    function gotoLicensePage(p) {
      licensePage = p;
      renderLicenseTable();
    }
    function gotoGiftPage(p) {
      giftPage = p;
      renderGiftTable();
    }
    function gotoRomPage(p) {
      romPage = p;
      renderRomTable();
    }

    function updateLicenseBulkToolbar() {
      const toolbar = document.getElementById("licenseBulkToolbar");
      const countText = document.getElementById("licenseBulkCountText");
      if (!toolbar) return;
      const count = selectedLicenseIds.size;
      if (count > 0) {
        toolbar.classList.add("show");
        if (countText) countText.innerText = "Đã chọn " + count + " mục";
      } else {
        toolbar.classList.remove("show");
      }
    }

    function toggleLicenseItem(id, isChecked) {
      if (isChecked) {
        selectedLicenseIds.add(id);
      } else {
        selectedLicenseIds.delete(id);
      }
      updateLicenseBulkToolbar();
      updateCheckAllLicensesState();
    }

    function toggleSelectAllLicenses(isChecked) {
      const filtered = getFilteredLicenses();
      const totalPages = Math.ceil(filtered.length / PAGE_SIZE) || 1;
      const curPage = Math.min(Math.max(1, licensePage), totalPages);
      const start = (curPage - 1) * PAGE_SIZE;
      const pageItems = filtered.slice(start, start + PAGE_SIZE);

      pageItems.forEach(function(item) {
        if (isChecked) {
          selectedLicenseIds.add(item.id);
        } else {
          selectedLicenseIds.delete(item.id);
        }
      });
      renderLicenseTable();
    }

    function clearLicenseSelection() {
      selectedLicenseIds.clear();
      renderLicenseTable();
    }

    function updateCheckAllLicensesState() {
      const checkAll = document.getElementById("checkAllLicenses");
      if (!checkAll) return;
      const filtered = getFilteredLicenses();
      const totalPages = Math.ceil(filtered.length / PAGE_SIZE) || 1;
      const curPage = Math.min(Math.max(1, licensePage), totalPages);
      const start = (curPage - 1) * PAGE_SIZE;
      const pageItems = filtered.slice(start, start + PAGE_SIZE);

      if (pageItems.length === 0) {
        checkAll.checked = false;
        checkAll.indeterminate = false;
        return;
      }
      const pageSelectedCount = pageItems.filter(function(it) { return selectedLicenseIds.has(it.id); }).length;
      if (pageSelectedCount === pageItems.length) {
        checkAll.checked = true;
        checkAll.indeterminate = false;
      } else if (pageSelectedCount > 0) {
        checkAll.checked = false;
        checkAll.indeterminate = true;
      } else {
        checkAll.checked = false;
        checkAll.indeterminate = false;
      }
    }

    function renderLicenseTable() {
      const tbody = document.getElementById("licenseTableBody");
      if (!tbody) return;

      const filtered = getFilteredLicenses();
      const totalCount = filtered.length;
      const totalPages = Math.ceil(totalCount / PAGE_SIZE) || 1;

      if (licensePage > totalPages) licensePage = totalPages;
      if (licensePage < 1) licensePage = 1;

      const start = (licensePage - 1) * PAGE_SIZE;
      const pageItems = filtered.slice(start, start + PAGE_SIZE);

      if (pageItems.length === 0) {
        tbody.innerHTML = '<tr><td colspan="10" style="text-align: center; color: var(--text-muted); padding: 24px;">Không tìm thấy bản ghi nào.</td></tr>';
      } else {
        tbody.innerHTML = pageItems.map(function(item, index) {
          const stt = start + index + 1;
          const isSelected = selectedLicenseIds.has(item.id);
          const linkHref = getGithubFileUrl("json/" + item.prefix + ".json");
          return '<tr onclick="openDetailModal(' + item.id + ')" style="' + (isSelected ? 'background: var(--table-hover);' : '') + '">' +
            '<td class="col-cb" onclick="event.stopPropagation()">' +
              '<input type="checkbox" ' + (isSelected ? 'checked' : '') + ' onchange="toggleLicenseItem(' + item.id + ', this.checked)">' +
            '</td>' +
            '<td class="col-stt"><b>' + stt + '</b></td>' +
            '<td><b><code>' + item.serial + '</code></b></td>' +
            '<td><code>' + item.rom_version + '</code></td>' +
            '<td><span class="badge badge-' + item.key_status + '">' + item.key_status + '</span></td>' +
            '<td>' + (item.email_phone || "-") + '</td>' +
            '<td>' + item.country + '</td>' +
            '<td><span class="badge badge-' + item.gmail_notify + '">' + item.gmail_notify + '</span></td>' +
            '<td>' +
              '<a href="' + linkHref + '" target="_blank" onclick="event.stopPropagation()" title="Mở file JSON trên GitHub Repo" style="text-decoration:none;">' +
                '<span class="badge badge-shard">🚀 json/' + item.prefix + '.json</span>' +
              '</a>' +
            '</td>' +
            '<td class="col-note">' + (item.note || "") + '</td>' +
          '</tr>';
        }).join('');
      }

      updateLicenseBulkToolbar();
      updateCheckAllLicensesState();
      renderPaginationUI("licensePagination", licensePage, totalPages, totalCount, "gotoLicensePage");
    }

    function renderRomDropdowns() {
      const roms = systemData.rom_categories || [];
      const options = roms.map(function(r) { return '<option value="' + r + '">' + r + '</option>'; }).join('');
      const addSel = document.getElementById("addRomSelect");
      if (addSel) addSel.innerHTML = options;
      const editSel = document.getElementById("editRomSelect");
      if (editSel) editSel.innerHTML = options;

      const filterSel = document.getElementById("licenseRomFilter");
      if (filterSel) {
        const curVal = filterSel.value;
        filterSel.innerHTML = '<option value="">-- Tất cả sản phẩm --</option>' +
          roms.map(function(r) { return '<option value="' + r + '"' + (r === curVal ? ' selected' : '') + '>' + r + '</option>'; }).join('');
      }
    }

    function renderRomTable() {
      const tbody = document.getElementById("romTableBody");
      if (!tbody) return;

      const filtered = getFilteredRoms();
      const totalCount = filtered.length;
      const totalPages = Math.ceil(totalCount / PAGE_SIZE) || 1;

      if (romPage > totalPages) romPage = totalPages;
      if (romPage < 1) romPage = 1;

      const start = (romPage - 1) * PAGE_SIZE;
      const pageItems = filtered.slice(start, start + PAGE_SIZE);

      if (pageItems.length === 0) {
        tbody.innerHTML = '<tr><td colspan="2" style="color:var(--text-muted); text-align:center; padding: 20px;">Không tìm thấy Sản phẩm nào.</td></tr>';
      } else {
        tbody.innerHTML = pageItems.map(function(r) {
          return '<tr>' +
            '<td><b><code>' + r + '</code></b></td>' +
            '<td style="text-align: center;"><button type="button" class="btn btn-red" style="padding:4px 8px;font-size:11px;" data-name="' + r + '" onclick="handleDeleteRom(this.dataset.name, this)">Xóa</button></td>' +
          '</tr>';
        }).join('');
      }

      renderPaginationUI("romPagination", romPage, totalPages, totalCount, "gotoRomPage");
    }

    function updateGiftBulkToolbar() {
      const toolbar = document.getElementById("giftBulkToolbar");
      const countText = document.getElementById("giftBulkCountText");
      if (!toolbar) return;
      const count = selectedGiftIds.size;
      if (count > 0) {
        toolbar.classList.add("show");
        if (countText) countText.innerText = "Đã chọn " + count + " mục";
      } else {
        toolbar.classList.remove("show");
      }
    }

    function toggleGiftItem(id, isChecked) {
      if (isChecked) {
        selectedGiftIds.add(id);
      } else {
        selectedGiftIds.delete(id);
      }
      updateGiftBulkToolbar();
      updateCheckAllGiftsState();
    }

    function toggleSelectAllGifts(isChecked) {
      const filtered = getFilteredGifts();
      const totalPages = Math.ceil(filtered.length / PAGE_SIZE) || 1;
      const curPage = Math.min(Math.max(1, giftPage), totalPages);
      const start = (curPage - 1) * PAGE_SIZE;
      const pageItems = filtered.slice(start, start + PAGE_SIZE);

      pageItems.forEach(function(item) {
        if (isChecked) {
          selectedGiftIds.add(item.id);
        } else {
          selectedGiftIds.delete(item.id);
        }
      });
      renderGiftTable();
    }

    function clearGiftSelection() {
      selectedGiftIds.clear();
      renderGiftTable();
    }

    function updateCheckAllGiftsState() {
      const checkAll = document.getElementById("checkAllGifts");
      if (!checkAll) return;
      const filtered = getFilteredGifts();
      const totalPages = Math.ceil(filtered.length / PAGE_SIZE) || 1;
      const curPage = Math.min(Math.max(1, giftPage), totalPages);
      const start = (curPage - 1) * PAGE_SIZE;
      const pageItems = filtered.slice(start, start + PAGE_SIZE);

      if (pageItems.length === 0) {
        checkAll.checked = false;
        checkAll.indeterminate = false;
        return;
      }
      const pageSelectedCount = pageItems.filter(function(it) { return selectedGiftIds.has(it.id); }).length;
      if (pageSelectedCount === pageItems.length) {
        checkAll.checked = true;
        checkAll.indeterminate = false;
      } else if (pageSelectedCount > 0) {
        checkAll.checked = false;
        checkAll.indeterminate = true;
      } else {
        checkAll.checked = false;
        checkAll.indeterminate = false;
      }
    }

    function renderGiftTable() {
      const tbody = document.getElementById("giftTableBody");
      if (!tbody) return;

      const badgeLink = document.getElementById("giftShardBadgeLink");
      if (badgeLink) {
        badgeLink.href = getGithubFileUrl("json/giftcode.json");
        badgeLink.title = "Mở file json/giftcode.json trên GitHub Repo";
      }

      const filtered = getFilteredGifts();
      const totalCount = filtered.length;
      const totalPages = Math.ceil(totalCount / PAGE_SIZE) || 1;

      if (giftPage > totalPages) giftPage = totalPages;
      if (giftPage < 1) giftPage = 1;

      const start = (giftPage - 1) * PAGE_SIZE;
      const pageItems = filtered.slice(start, start + PAGE_SIZE);
      const todayStr = new Date().toISOString().split("T")[0];

      if (pageItems.length === 0) {
        tbody.innerHTML = '<tr><td colspan="8" style="text-align: center; color: var(--text-muted); padding: 24px;">Không tìm thấy Gift Code nào. Bấm nút "+ Tạo Gift Code" ở trên để thêm.</td></tr>';
      } else {
        tbody.innerHTML = pageItems.map(function(item, index) {
          const stt = start + index + 1;
          const isSelected = selectedGiftIds.has(item.id);
          const isExpired = item.expiration_date < todayStr;
          const statusBadge = isExpired
            ? '<span class="badge badge-OFF">BLOCK</span>'
            : '<span class="badge badge-OK">OK</span>';

          return '<tr style="' + (isSelected ? 'background: var(--table-hover);' : '') + '">' +
            '<td class="col-cb" onclick="event.stopPropagation()">' +
              '<input type="checkbox" ' + (isSelected ? 'checked' : '') + ' onchange="toggleGiftItem(' + item.id + ', this.checked)">' +
            '</td>' +
            '<td class="col-stt"><b>' + stt + '</b></td>' +
            '<td><b><code>' + item.gift_code + '</code></b></td>' +
            '<td><code>' + item.start_date + '</code></td>' +
            '<td><code>' + item.expiration_date + '</code></td>' +
            '<td>' + statusBadge + '</td>' +
            '<td class="col-note">' + (item.note || "-") + '</td>' +
            '<td class="col-actions">' +
              '<button type="button" class="btn btn-blue" style="padding: 4px 8px; font-size: 11px; margin-right: 4px;" onclick="openEditGiftModal(' + item.id + ')">Sửa</button>' +
              '<button type="button" class="btn btn-red" style="padding: 4px 8px; font-size: 11px;" data-code="' + item.gift_code + '" onclick="handleDeleteGiftKey(' + item.id + ', this.dataset.code, this)">Xóa</button>' +
            '</td>' +
          '</tr>';
        }).join('');
      }

      updateGiftBulkToolbar();
      updateCheckAllGiftsState();
      renderPaginationUI("giftPagination", giftPage, totalPages, totalCount, "gotoGiftPage");
    }

    async function handleBulkDeleteLicenses() {
      if (selectedLicenseIds.size === 0) return;
      const count = selectedLicenseIds.size;
      const confirmed = await showConfirm(
        "Xác nhận xóa hàng loạt",
        "Bạn có chắc chắn muốn xóa vĩnh viễn " + count + " bản ghi đã chọn? Các file shard tương ứng sẽ được cập nhật lại.",
        true
      );
      if (!confirmed) return;
      const delBtn = document.getElementById("btnBulkDeleteLicense");
      setBtnLoading(delBtn, true, "Đang xóa...");
      try {
        const res = await sendAdminAction({
          action: "bulk_delete_licenses",
          ids: Array.from(selectedLicenseIds)
        }, "Đang xóa " + count + " mục & cập nhật Shards...");
        if (res && res.success) {
          selectedLicenseIds.clear();
          await loadAllData();
          showToast(res.message || "Đã xóa thành công!", "success", 6000);
        } else {
          showToast("Lỗi xóa hàng loạt: " + ((res && res.error) || "Không rõ"), "error", 6000);
        }
      } finally {
        setBtnLoading(delBtn, false);
      }
    }

    function openBulkEditLicenseModal() {
      if (selectedLicenseIds.size === 0) {
        return showToast("Vui lòng chọn ít nhất 1 mục để sửa!", "warn");
      }
      const tbody = document.getElementById("bulkEditLicenseTbody");
      if (!tbody) return;

      const itemsToEdit = systemData.licenses.filter(function(it) { return selectedLicenseIds.has(it.id); });
      const romOptionsHtml = (systemData.rom_categories || []).map(function(r) { return '<option value="' + r + '">' + r + '</option>'; }).join("");

      tbody.innerHTML = itemsToEdit.map(function(item, idx) {
        const stt = idx + 1;
        return '<tr data-id="' + item.id + '" data-prefix="' + (item.prefix || "") + '">' +
          '<td style="text-align: center; font-weight: bold;">' + stt + '</td>' +
          '<td><input type="text" class="bulk-cell-input bulk-serial" value="' + (item.serial || "") + '" style="font-family: monospace; font-weight: bold;"></td>' +
          '<td><select class="bulk-cell-select bulk-rom" data-selected="' + (item.rom_version || "") + '">' + romOptionsHtml + '</select></td>' +
          '<td><select class="bulk-cell-select bulk-status">' +
            '<option value="OK"' + (item.key_status === 'OK' ? ' selected' : '') + '>OK</option>' +
            '<option value="DEL"' + (item.key_status === 'DEL' ? ' selected' : '') + '>DEL</option>' +
          '</select></td>' +
          '<td><input type="text" class="bulk-cell-input bulk-email" value="' + (item.email_phone || "") + '"></td>' +
          '<td><select class="bulk-cell-select bulk-country">' +
            '<option value="VN"' + (item.country === 'VN' ? ' selected' : '') + '>VN</option>' +
            '<option value="Other"' + (item.country === 'Other' ? ' selected' : '') + '>Other</option>' +
          '</select></td>' +
          '<td><select class="bulk-cell-select bulk-gmail">' +
            '<option value="NONE"' + (item.gmail_notify === 'NONE' ? ' selected' : '') + '>NONE</option>' +
            '<option value="SENT"' + (item.gmail_notify === 'SENT' ? ' selected' : '') + '>SENT</option>' +
          '</select></td>' +
          '<td class="col-note"><input type="text" class="bulk-cell-input bulk-note" value="' + (item.note || "") + '"></td>' +
        '</tr>';
      }).join("");

      tbody.querySelectorAll(".bulk-rom").forEach(function(sel) {
        const val = sel.getAttribute("data-selected");
        if (val) sel.value = val;
      });

      document.getElementById("bulkEditLicenseModal").style.display = "flex";
    }

    function closeBulkEditLicenseModal() {
      document.getElementById("bulkEditLicenseModal").style.display = "none";
    }

    async function saveBulkEditLicenses() {
      const tbody = document.getElementById("bulkEditLicenseTbody");
      const rows = tbody.querySelectorAll("tr");
      const itemsToUpdate = [];

      for (const row of rows) {
        const id = Number(row.getAttribute("data-id"));
        const old_prefix = row.getAttribute("data-prefix") || "";
        const serial = row.querySelector(".bulk-serial").value.trim();
        const rom_version = row.querySelector(".bulk-rom").value;
        const key_status = row.querySelector(".bulk-status").value;
        const email_phone = row.querySelector(".bulk-email").value.trim();
        const country = row.querySelector(".bulk-country").value;
        const gmail_notify = row.querySelector(".bulk-gmail").value;
        const note = row.querySelector(".bulk-note").value.trim();

        if (!serial) {
          return showToast("Serial không được để trống!", "warn");
        }
        if (!rom_version) {
          return showToast("Vui lòng chọn Phiên bản cho tất cả các dòng!", "warn");
        }

        itemsToUpdate.push({
          id: id,
          serial: serial,
          rom_version: rom_version,
          key_status: key_status,
          email_phone: email_phone,
          country: country,
          gmail_notify: gmail_notify,
          note: note,
          old_prefix: old_prefix
        });
      }

      const saveBtn = document.getElementById("btnSaveBulkLicenses");
      setBtnLoading(saveBtn, true, "Đang đồng bộ...");

      showToast("Đang đồng bộ " + itemsToUpdate.length + " mục lên D1 và GitHub...", "info");

      try {
        const res = await sendAdminAction({
          action: "bulk_update_licenses",
          items: itemsToUpdate
        }, "Đang đồng bộ " + itemsToUpdate.length + " mục lên D1 và GitHub...");

        if (res && res.success) {
          closeBulkEditLicenseModal();
          selectedLicenseIds.clear();
          await loadAllData();
          showToast(res.message || "Đã lưu và đồng bộ thành công!", "success", 7000);
        } else {
          showToast("Lỗi đồng bộ: " + ((res && res.error) || "Không rõ"), "error", 7000);
        }
      } catch (err) {
        showToast("Lỗi kết nối: " + err.message, "error");
      } finally {
        setBtnLoading(saveBtn, false);
      }
    }

    async function handleBulkDeleteGifts() {
      if (selectedGiftIds.size === 0) return;
      const count = selectedGiftIds.size;
      const confirmed = await showConfirm(
        "Xác nhận xóa Gift Code",
        "Bạn có chắc chắn muốn xóa " + count + " mã Gift Code đã chọn?",
        true
      );
      if (!confirmed) return;
      const delBtn = document.getElementById("btnBulkDeleteGift");
      setBtnLoading(delBtn, true, "Đang xóa...");
      try {
        const res = await sendAdminAction({
          action: "bulk_delete_gift_keys",
          ids: Array.from(selectedGiftIds)
        }, "Đang xóa " + count + " Gift Code...");
        if (res && res.success) {
          selectedGiftIds.clear();
          await loadAllData();
          showToast(res.message || "Đã xóa Gift Code thành công!", "success", 6000);
        } else {
          showToast("Lỗi xóa: " + ((res && res.error) || "Không rõ"), "error", 6000);
        }
      } finally {
        setBtnLoading(delBtn, false);
      }
    }

    function openBulkEditGiftModal() {
      if (selectedGiftIds.size === 0) {
        return showToast("Vui lòng chọn ít nhất 1 Gift Code để sửa!", "warn");
      }
      const tbody = document.getElementById("bulkEditGiftTbody");
      if (!tbody) return;

      const itemsToEdit = systemData.gift_keys.filter(function(it) { return selectedGiftIds.has(it.id); });
      tbody.innerHTML = itemsToEdit.map(function(item, idx) {
        const stt = idx + 1;
        return '<tr data-id="' + item.id + '">' +
          '<td style="text-align: center; font-weight: bold;">' + stt + '</td>' +
          '<td><input type="text" class="bulk-cell-input bulk-gift-code" value="' + (item.gift_code || "") + '" style="font-family: monospace; font-weight: bold; text-transform: uppercase;"></td>' +
          '<td><input type="date" class="bulk-cell-input bulk-gift-start" value="' + (item.start_date || "") + '"></td>' +
          '<td><input type="date" class="bulk-cell-input bulk-gift-exp" value="' + (item.expiration_date || "") + '"></td>' +
          '<td class="col-note"><input type="text" class="bulk-cell-input bulk-gift-note" value="' + (item.note || "") + '"></td>' +
        '</tr>';
      }).join("");

      document.getElementById("bulkEditGiftModal").style.display = "flex";
    }

    function closeBulkEditGiftModal() {
      document.getElementById("bulkEditGiftModal").style.display = "none";
    }

    async function saveBulkEditGifts() {
      const tbody = document.getElementById("bulkEditGiftTbody");
      const rows = tbody.querySelectorAll("tr");
      const itemsToUpdate = [];

      for (const row of rows) {
        const id = Number(row.getAttribute("data-id"));
        const gift_code = row.querySelector(".bulk-gift-code").value.trim().toUpperCase();
        const start_date = row.querySelector(".bulk-gift-start").value.trim();
        const expiration_date = row.querySelector(".bulk-gift-exp").value.trim();
        const note = row.querySelector(".bulk-gift-note").value.trim();

        if (!gift_code) return showToast("GIFT_CODE không được để trống!", "warn");
        if (!start_date || !expiration_date) return showToast("Vui lòng chọn đủ ngày bắt đầu và kết thúc!", "warn");
        if (start_date > expiration_date) return showToast("Ngày bắt đầu không được lớn hơn ngày hết hạn!", "warn");

        itemsToUpdate.push({ id: id, gift_code: gift_code, start_date: start_date, expiration_date: expiration_date, note: note });
      }

      const saveBtn = document.getElementById("btnSaveBulkGifts");
      setBtnLoading(saveBtn, true, "Đang đồng bộ...");

      showToast("Đang đồng bộ " + itemsToUpdate.length + " Gift Code lên D1 và GitHub...", "info");

      try {
        const res = await sendAdminAction({
          action: "bulk_update_gift_keys",
          items: itemsToUpdate
        }, "Đang đồng bộ " + itemsToUpdate.length + " Gift Code lên D1 và GitHub...");

        if (res && res.success) {
          closeBulkEditGiftModal();
          selectedGiftIds.clear();
          await loadAllData();
          showToast(res.message || "Đã lưu và đồng bộ Gift Code thành công!", "success", 7000);
        } else {
          showToast("Lỗi đồng bộ: " + ((res && res.error) || "Không rõ"), "error", 7000);
        }
      } catch (err) {
        showToast("Lỗi kết nối: " + err.message, "error");
      } finally {
        setBtnLoading(saveBtn, false);
      }
    }

    function openUploadModal(type) {
      currentUploadType = type;
      parsedImportData = [];
      const fileInput = document.getElementById("excelFileInput");
      if (fileInput) fileInput.value = "";

      const titleEl = document.getElementById("uploadModalTitle");
      const descEl = document.getElementById("uploadModalDesc");
      const fileNameEl = document.getElementById("uploadFileNameText");
      const summaryEl = document.getElementById("uploadSummaryText");
      const confirmBtn = document.getElementById("btnConfirmUpload");
      const previewTable = document.getElementById("uploadPreviewTable");

      if (type === "license") {
        titleEl.innerText = "📥 Upload Excel Danh sách Kích hoạt";
        descEl.innerText = "Tải lên tệp Excel chứa danh sách bản quyền. Cần các cột từ SERIAL đến GỬI MAIL (SERIAL, PHIÊN BẢN, TRẠNG THÁI KEY, EMAIL/SĐT, QUỐC GIA, GỬI MAIL).";
      } else {
        titleEl.innerText = "📥 Upload Excel Danh mục Sản phẩm";
        descEl.innerText = "Tải lên tệp Excel chứa danh mục sản phẩm. Chỉ cần 1 cột duy nhất: TÊN SẢN PHẨM.";
      }

      fileNameEl.innerText = "Nhấp để chọn tệp Excel hoặc kéo thả vào đây";
      summaryEl.innerText = "";
      confirmBtn.disabled = true;
      confirmBtn.innerText = "Nhập dữ liệu"; 

      previewTable.querySelector("thead").innerHTML = "";
      previewTable.querySelector("tbody").innerHTML = '<tr><td style="text-align: center; color: var(--text-muted); padding: 16px;">Chưa chọn tệp tin nào.</td></tr>';

      document.getElementById("uploadExcelModal").style.display = "flex";
    }

    function closeUploadModal() {
      document.getElementById("uploadExcelModal").style.display = "none";
      parsedImportData = [];
    }

    function handleExcelFileSelected(event) {
      const file = event.target.files && event.target.files[0];
      if (!file) return;

      document.getElementById("uploadFileNameText").innerText = "📄 " + file.name + " (" + (file.size / 1024).toFixed(1) + " KB)";

      const reader = new FileReader();
      reader.onload = function(e) {
        try {
          const data = new Uint8Array(e.target.result);
          const workbook = XLSX.read(data, { type: 'array' });
          const firstSheetName = workbook.SheetNames[0];
          const worksheet = workbook.Sheets[firstSheetName];
          const rawRows = XLSX.utils.sheet_to_json(worksheet, { defval: "" });

          if (!rawRows || rawRows.length === 0) {
            showToast("Tệp Excel không có dữ liệu!", "warn");
            return;
          }

          processExcelRows(rawRows);
        } catch (err) {
          showToast("Lỗi đọc file Excel: " + err.message, "error");
        }
      };
      reader.readAsArrayBuffer(file);
    }

    function normalizeHeaderKey(key) {
      return String(key || "")
        .trim()
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9]/g, "");
    }

    function processExcelRows(rawRows) {
      const previewTable = document.getElementById("uploadPreviewTable");
      const summaryEl = document.getElementById("uploadSummaryText");
      const confirmBtn = document.getElementById("btnConfirmUpload");

      if (currentUploadType === "license") {
        const validItems = [];

        rawRows.forEach(function(row) {
          let serial = "", rom = "", status = "OK", email = "", country = "VN", gmail = "NONE", note = "";

          for (const rawKey of Object.keys(row)) {
            const normKey = normalizeHeaderKey(rawKey);
            const val = String(row[rawKey] || "").trim();

            if (normKey === "serial" || normKey === "imei") serial = val;
            else if (normKey.indexOf("phienban") !== -1 || normKey.indexOf("rom") !== -1 || normKey.indexOf("sanpham") !== -1) rom = val;
            else if (normKey.indexOf("trangthai") !== -1 || normKey === "status") status = val || "OK";
            else if (normKey.indexOf("email") !== -1 || normKey.indexOf("sdt") !== -1 || normKey.indexOf("phone") !== -1) email = val;
            else if (normKey.indexOf("quocgia") !== -1 || normKey === "country") country = val || "VN";
            else if (normKey.indexOf("guimail") !== -1 || normKey.indexOf("mailnotify") !== -1) gmail = val || "NONE";
            else if (normKey.indexOf("ghichu") !== -1 || normKey === "note") note = val;
          }

          if (serial && rom) {
            validItems.push({
              serial: serial,
              rom_version: rom,
              key_status: status.toUpperCase() === "DEL" ? "DEL" : "OK",
              email_phone: email,
              country: country.toUpperCase() === "OTHER" ? "Other" : "VN",
              gmail_notify: gmail.toUpperCase() === "SENT" ? "SENT" : "NONE",
              note: note
            });
          }
        });

        parsedImportData = validItems;

        if (validItems.length === 0) {
          summaryEl.innerText = "❌ Không tìm thấy dòng nào có đủ cột SERIAL và PHIÊN BẢN!";
          summaryEl.style.color = "#ef4444";
          confirmBtn.disabled = true;
          return;
        }

        summaryEl.innerText = "✅ Đã tìm thấy " + validItems.length + " bản ghi hợp lệ sẵn sàng nhập.";
        summaryEl.style.color = "#0284c7";
        confirmBtn.disabled = false;

        const previewRows = validItems.slice(0, 5);
        previewTable.querySelector("thead").innerHTML = '<tr><th>STT</th><th>SERIAL</th><th>PHIÊN BẢN</th><th>TRẠNG THÁI</th><th>EMAIL/SĐT</th><th>QUỐC GIA</th><th>GỬI MAIL</th></tr>';
        previewTable.querySelector("tbody").innerHTML = previewRows.map(function(it, idx) {
          return '<tr>' +
            '<td>' + (idx + 1) + '</td>' +
            '<td><code>' + it.serial + '</code></td>' +
            '<td>' + it.rom_version + '</td>' +
            '<td>' + it.key_status + '</td>' +
            '<td>' + (it.email_phone || '-') + '</td>' +
            '<td>' + it.country + '</td>' +
            '<td>' + it.gmail_notify + '</td>' +
          '</tr>';
        }).join("");
      } else {
        const validNames = new Set();

        rawRows.forEach(function(row) {
          for (const rawKey of Object.keys(row)) {
            const normKey = normalizeHeaderKey(rawKey);
            const val = String(row[rawKey] || "").trim();
            if (normKey.indexOf("tensanpham") !== -1 || normKey.indexOf("sanpham") !== -1 || normKey.indexOf("rom") !== -1 || normKey.indexOf("product") !== -1 || normKey.indexOf("name") !== -1) {
              if (val) validNames.add(val);
            }
          }
        });

        if (validNames.size === 0) {
          rawRows.forEach(function(row) {
            const firstKey = Object.keys(row)[0];
            const val = String(row[firstKey] || "").trim();
            if (val) validNames.add(val);
          });
        }

        parsedImportData = Array.from(validNames);

        if (parsedImportData.length === 0) {
          summaryEl.innerText = "❌ Không tìm thấy tên sản phẩm nào trong tệp!";
          summaryEl.style.color = "#ef4444";
          confirmBtn.disabled = true;
          return;
        }

        summaryEl.innerText = "✅ Đã tìm thấy " + parsedImportData.length + " sản phẩm sẵn sàng nhập.";
        summaryEl.style.color = "#0284c7";
        confirmBtn.disabled = false;

        const previewRows = parsedImportData.slice(0, 5);
        previewTable.querySelector("thead").innerHTML = '<tr><th style="width: 50px;">STT</th><th>TÊN SẢN PHẨM</th></tr>';
        previewTable.querySelector("tbody").innerHTML = previewRows.map(function(name, idx) {
          return '<tr><td>' + (idx + 1) + '</td><td><b><code>' + name + '</code></b></td></tr>';
        }).join("");
      }
    }

    function downloadSampleExcel() {
      if (typeof XLSX === "undefined") {
        return showToast("Thư viện SheetJS chưa được tải xong, vui lòng thử lại sau giây lát!", "warn");
      }

      if (currentUploadType === "license") {
        const sampleData = [
          {
            "SERIAL": "G6AY8400E7W",
            "PHIÊN BẢN": (systemData.rom_categories && systemData.rom_categories[0]) || "PRO_V1",
            "TRẠNG THÁI KEY": "OK",
            "EMAIL/SĐT": "khachhang1@gmail.com",
            "QUỐC GIA": "VN",
            "GỬI MAIL": "NONE",
            "GHI CHÚ": "Kích hoạt ngày 16/10"
          },
          {
            "SERIAL": "A9BX1200Z4K",
            "PHIÊN BẢN": (systemData.rom_categories && systemData.rom_categories[0]) || "PRO_V1",
            "TRẠNG THÁI KEY": "OK",
            "EMAIL/SĐT": "khachhang2@gmail.com",
            "QUỐC GIA": "Other",
            "GỬI MAIL": "NONE",
            "GHI CHÚ": "Bản quốc tế"
          }
        ];
        const ws = XLSX.utils.json_to_sheet(sampleData);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, "DanhSachKichHoat");
        XLSX.writeFile(wb, "Mau_Danh_Sach_Kich_Hoat.xlsx");
      } else {
        const sampleData = [
          { "TÊN SẢN PHẨM": "Bản quyền Pro V1.0" },
          { "TÊN SẢN PHẨM": "Bản quyền VIP V2.0" }
        ];
        const ws = XLSX.utils.json_to_sheet(sampleData);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, "SanPham");
        XLSX.writeFile(wb, "Mau_Danh_Muc_San_Pham.xlsx");
      }
    }

    async function executeBulkImport() {
      if (!parsedImportData || parsedImportData.length === 0) return;

      const confirmBtn = document.getElementById("btnConfirmUpload");
      setBtnLoading(confirmBtn, true, "Đang nhập dữ liệu...");
      showToast("Đang nhập dữ liệu vào hệ thống...", "info");

      try {
        let res;
        if (currentUploadType === "license") {
          res = await sendAdminAction({
            action: "bulk_import_licenses",
            items: parsedImportData
          }, "Đang nhập danh sách Kích hoạt từ Excel...");
        } else {
          res = await sendAdminAction({
            action: "bulk_import_roms",
            names: parsedImportData
          }, "Đang nhập danh mục Sản phẩm từ Excel...");
        }

        if (res && res.success) {
          closeUploadModal();
          await loadAllData();
          showToast(res.message || "Đã nhập dữ liệu thành công!", "success", 7000);
        } else {
          showToast("Lỗi nhập dữ liệu: " + ((res && res.error) || "Không rõ"), "error", 7000);
        }
      } catch (err) {
        showToast("Lỗi kết nối: " + err.message, "error");
      } finally {
        setBtnLoading(confirmBtn, false);
      }
    }

    function openCreateGiftModal() {
      document.getElementById("giftId").value = "";
      document.getElementById("giftModalTitle").innerText = "Tạo Gift Code Mới";
      document.getElementById("giftCodeInput").value = "";
      const today = new Date().toISOString().split("T")[0];
      document.getElementById("giftStartDate").value = today;

      const nextMonth = new Date();
      nextMonth.setDate(nextMonth.getDate() + 30);
      document.getElementById("giftExpDate").value = nextMonth.toISOString().split("T")[0];

      document.getElementById("giftNote").value = "";
      document.getElementById("giftModal").style.display = "flex";
    }

    function openEditGiftModal(id) {
      const item = (systemData.gift_keys || []).find(g => g.id === id);
      if (!item) return;
      document.getElementById("giftId").value = item.id;
      document.getElementById("giftModalTitle").innerText = "Chỉnh Sửa Gift Code";
      document.getElementById("giftCodeInput").value = item.gift_code;
      document.getElementById("giftStartDate").value = item.start_date;
      document.getElementById("giftExpDate").value = item.expiration_date;
      document.getElementById("giftNote").value = item.note || "";
      document.getElementById("giftModal").style.display = "flex";
    }

    function closeGiftModal() {
      document.getElementById("giftModal").style.display = "none";
    }

    function generateRandomGiftCode() {
      const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
      let p1 = "", p2 = "";
      for (let i = 0; i < 4; i++) p1 += chars.charAt(Math.floor(Math.random() * chars.length));
      for (let i = 0; i < 4; i++) p2 += chars.charAt(Math.floor(Math.random() * chars.length));
      document.getElementById("giftCodeInput").value = "GIFT-" + p1 + "-" + p2;
    }

    async function handleSaveGiftKey() {
      const id = document.getElementById("giftId").value;
      const gift_code = document.getElementById("giftCodeInput").value.trim().toUpperCase();
      const start_date = document.getElementById("giftStartDate").value.trim();
      const expiration_date = document.getElementById("giftExpDate").value.trim();
      const note = document.getElementById("giftNote").value.trim();

      if (!gift_code) return showToast("Vui lòng nhập GIFT_CODE!", "warn");
      if (!start_date || !expiration_date) return showToast("Vui lòng chọn ngày bắt đầu và kết thúc!", "warn");
      if (start_date > expiration_date) return showToast("Ngày bắt đầu không được lớn hơn ngày hết hạn!", "warn");

      const saveBtn = document.getElementById("btnSaveGift");
      setBtnLoading(saveBtn, true, "Đang lưu...");

      try {
        const action = id ? "update_gift_key" : "create_gift_key";
        const loadingMsg = id ? "Đang cập nhật Gift Code..." : "Đang tạo Gift Code & đồng bộ file JSON...";
        const res = await sendAdminAction(
          { action, id: id ? Number(id) : undefined, gift_code, start_date, expiration_date, note },
          loadingMsg
        );
        if (res && res.success) {
          closeGiftModal();
          await loadAllData();
          showToast(res.message || "Đã lưu Gift Code thành công!", "success", 6000);
        } else {
          showToast("Lỗi lưu Gift Code: " + ((res && res.error) || "Không rõ"), "error", 6000);
        }
      } finally {
        setBtnLoading(saveBtn, false);
      }
    }

    async function handleDeleteGiftKey(id, code, btnEl) {
      const confirmed = await showConfirm(
        "Xác nhận xóa Gift Code",
        'Bạn có chắc chắn muốn xóa mã gift code "' + code + '"?',
        true
      );
      if (!confirmed) return;
      if (btnEl) setBtnLoading(btnEl, true, "Đang xóa...");
      try {
        const res = await sendAdminAction({ action: "delete_gift_key", id: Number(id) }, "Đang xóa Gift Code...");
        if (res && res.success) {
          await loadAllData();
          showToast(res.message || "Đã xóa Gift Code thành công!", "success", 6000);
        } else {
          showToast("Lỗi xóa Gift Code: " + ((res && res.error) || "Không rõ"), "error", 6000);
        }
      } finally {
        if (btnEl) setBtnLoading(btnEl, false);
      }
    }

    async function handleSyncGiftCode() {
      const res = await sendAdminAction({ action: "sync_gift_code" }, "Đang đồng bộ giftcode.json lên GitHub...");
      if (res && res.success) {
        showToast(res.message || "Đã đồng bộ giftcode.json thành công!", "success", 8000);
      } else {
        showToast("Lỗi đồng bộ: " + (res.error || "Không rõ"), "error", 8000);
      }
    }

    function openDetailModal(id) {
      currentSelectedItem = systemData.licenses.find(i => i.id === id);
      if (!currentSelectedItem) return;

      const prefix = currentSelectedItem.prefix || "unk";
      const rawUrl = getGithubFileUrl("json/" + prefix + ".json");
      document.getElementById("editId").value = currentSelectedItem.id;
      const prefixLink = document.getElementById("editPrefixLink");
      const prefixText = document.getElementById("editPrefixText");
      if (prefixLink) {
        prefixLink.href = rawUrl;
        prefixLink.title = "Mở file JSON RAW: " + rawUrl;
      }
      if (prefixText) {
        prefixText.innerText = "json/" + prefix + ".json";
      }
      document.getElementById("editSerial").value = currentSelectedItem.serial;
      document.getElementById("editRomSelect").value = currentSelectedItem.rom_version;
      document.getElementById("editStatus").value = currentSelectedItem.key_status;
      document.getElementById("editEmail").value = currentSelectedItem.email_phone || "";
      document.getElementById("editCountry").value = currentSelectedItem.country || "VN";
      document.getElementById("editNote").value = currentSelectedItem.note || "";

      const sendBtn = document.getElementById("btnSendMail");
      if (sendBtn) {
        if (currentSelectedItem.gmail_notify === "SENT") {
          sendBtn.style.display = "none";
        } else {
          sendBtn.style.display = "inline-block";
          sendBtn.innerHTML = "Gửi Email kích hoạt";
          sendBtn.disabled = false;
        }
      }

      toggleEditMode(false);
      document.getElementById("detailModal").style.display = "flex";
    }

    function closeModal() {
      document.getElementById("detailModal").style.display = "none";
      toggleEditMode(false);
    }

    function toggleEditMode(isEdit) {
      const fields = ["editSerial", "editRomSelect", "editStatus", "editEmail", "editCountry", "editNote"];
      fields.forEach(f => document.getElementById(f).disabled = !isEdit);

      document.getElementById("modalFooterView").style.display = isEdit ? "none" : "flex";
      document.getElementById("modalFooterEdit").style.display = isEdit ? "flex" : "none";
    }

    async function handleSaveEdit() {
      const saveBtn = document.getElementById("btnSaveEdit");
      setBtnLoading(saveBtn, true, "Đang lưu...");

      try {
        const payload = {
          action: "update_license",
          id: parseInt(document.getElementById("editId").value),
          serial: document.getElementById("editSerial").value.trim(),
          rom_version: document.getElementById("editRomSelect").value,
          key_status: document.getElementById("editStatus").value,
          email_phone: document.getElementById("editEmail").value.trim(),
          country: document.getElementById("editCountry").value,
          note: document.getElementById("editNote").value.trim()
        };

        const res = await sendAdminAction(payload, "Đang lưu thay đổi & đồng bộ Shard...");
        if (!res || !res.success) {
          return showToast((res && res.error) || "Không thể lưu thay đổi!", "error");
        }

        closeModal();
        await loadAllData();
        showToast("Đã lưu cập nhật thành công!", "success");
      } finally {
        setBtnLoading(saveBtn, false);
      }
    }

    async function handleDeleteFromModal() {
      const serialName = currentSelectedItem ? currentSelectedItem.serial : "";
      const confirmed = await showConfirm(
        "Xác nhận xóa",
        'Bạn có chắc chắn muốn xóa vĩnh viễn thiết bị có Serial "' + serialName + '"?',
        true
      );
      if (confirmed) {
        const delBtn = document.getElementById("btnDeleteKey");
        setBtnLoading(delBtn, true, "Đang xóa...");
        try {
          const res = await sendAdminAction({ action: "delete_license", id: currentSelectedItem.id }, "Đang xóa thiết bị & cập nhật Shard...");
          if (res && res.success) {
            closeModal();
            await loadAllData();
            showToast("Đã xóa thiết bị thành công!", "success");
          } else {
            showToast("Lỗi xóa: " + ((res && res.error) || "Không thể xóa"), "error");
          }
        } finally {
          setBtnLoading(delBtn, false);
        }
      }
    }

    function openCreateLicenseModal() {
      document.getElementById("addSerial").value = "";
      document.getElementById("addEmail").value = "";
      document.getElementById("addNote").value = "";
      document.getElementById("createLicenseModal").style.display = "flex";
    }

    function closeCreateLicenseModal() {
      document.getElementById("createLicenseModal").style.display = "none";
    }

    async function handleCreateLicense() {
      const serial = document.getElementById("addSerial").value.trim();
      const rom_version = document.getElementById("addRomSelect").value;
      if (!serial) return showToast("Vui lòng nhập Serial!", "warn");

      const saveBtn = document.getElementById("btnSaveNewLicense");
      setBtnLoading(saveBtn, true, "Đang tạo...");

      try {
        const res = await sendAdminAction({
          action: "create_license",
          serial,
          rom_version,
          key_status: document.getElementById("addStatus").value,
          email_phone: document.getElementById("addEmail").value.trim(),
          country: document.getElementById("addCountry").value,
          note: document.getElementById("addNote").value.trim()
        }, "Đang tạo thiết bị & đồng bộ Shard...");

        if (!res || !res.success) {
          return showToast((res && res.error) || "Không thể tạo bản ghi!", "error");
        }

        closeCreateLicenseModal();
        document.getElementById("addSerial").value = "";
        document.getElementById("addEmail").value = "";
        document.getElementById("addNote").value = "";
        showToast(res.message || ("Đã thêm thiết bị mới thành công (Shard: json/" + res.prefix + ".json)!"), "success", 6000);
        await loadAllData();
      } finally {
        setBtnLoading(saveBtn, false);
      }
    }

    async function handleSyncAllPrefixes() {
      const confirmed = await showConfirm(
        "Đồng bộ Shards tĩnh",
        "Hệ thống sẽ tính toán lại tiền tố (Prefix) cho toàn bộ license trong CSDL D1 và đồng bộ lên GitHub Repo. Bạn có muốn tiếp tục?",
        false
      );
      if (!confirmed) return;
      const btn = document.getElementById("btnSyncShards");
      setBtnLoading(btn, true, "Đang đồng bộ...");
      try {
        const res = await sendAdminAction({ action: "reindex_all_prefixes" }, "Đang tính toán lại Prefix & đồng bộ tất cả Shards...");
        if (res && res.success) {
          showToast(res.message || "Đã đồng bộ thành công!", "success", 8000);
          await loadAllData();
        } else {
          showToast("Lỗi đồng bộ: " + ((res && res.error) || "Không rõ"), "error", 8000);
        }
      } finally {
        setBtnLoading(btn, false);
      }
    }

    async function handleAddRom() {
      const name = document.getElementById("newRomName").value.trim();
      if (!name) return showToast("Vui lòng nhập tên Sản phẩm!", "warn");
      const btn = document.getElementById("btnAddRom");
      setBtnLoading(btn, true, "Đang thêm...");
      try {
        const res = await sendAdminAction({ action: "add_rom", name }, "Đang thêm Sản phẩm mới...");
        if (res && res.success !== false) {
          document.getElementById("newRomName").value = "";
          await loadAllData();
          showToast('Đã thêm Sản phẩm "' + name + '"', "success");
        } else {
          showToast("Lỗi: " + ((res && res.error) || "Không thể thêm"), "error");
        }
      } finally {
        setBtnLoading(btn, false);
      }
    }

    async function handleDeleteRom(name, btnEl) {
      const confirmed = await showConfirm(
        "Xác nhận xóa",
        'Bạn có chắc chắn muốn xóa "' + name + '"?',
        true
      );
      if (confirmed) {
        if (btnEl) setBtnLoading(btnEl, true, "Đang xóa...");
        try {
          const res = await sendAdminAction({ action: "delete_rom", name }, "Đang xóa Sản phẩm...");
          if (res && res.success !== false) {
            await loadAllData();
            showToast('Đã xóa "' + name + '"', "success");
          } else {
            showToast("Lỗi: " + ((res && res.error) || "Không thể xóa"), "error");
          }
        } finally {
          if (btnEl) setBtnLoading(btnEl, false);
        }
      }
    }

    async function sendAdminAction(payload, customLoadingText) {
      showActionLoader(customLoadingText || "Đang xử lý yêu cầu...");
      try {
        const res = await fetch("/api/admin/action", {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": "Bearer " + currentAuthToken },
          body: JSON.stringify(payload)
        });
        return await res.json();
      } catch (err) {
        return { success: false, error: err.message };
      } finally {
        hideActionLoader();
      }
    }

    async function handleResendMailFromModal(btn) {
      if (!currentSelectedItem) return;

      const emailVal = (currentSelectedItem.email_phone || "").trim();
      if (!emailVal.includes("@")) {
        return showToast("Mục này chưa có Email hợp lệ để gửi!", "warn");
      }

      const targetBtn = btn || document.getElementById("btnSendMail");
      setBtnLoading(targetBtn, true, "Đang gửi...");

      showToast("Đang kích hoạt lệnh gửi mail...", "info");

      try {
        const res = await sendAdminAction({ action: "resend_mail", id: currentSelectedItem.id }, "Đang gửi email kích hoạt...");
        
        if (res && res.success) {
          if (targetBtn) targetBtn.innerHTML = "✅ Đã gửi lệnh!";
          setTimeout(async () => {
            closeModal();
            await loadAllData();
            showToast("Đã gửi email thành công! Vui lòng kiểm tra hộp thư.", "success");
          }, 1000);
        } else {
          showToast("Lỗi gửi mail: " + ((res && res.error) || "Không gửi được"), "error");
          setBtnLoading(targetBtn, false);
        }
      } catch (e) {
        showToast("Lỗi kết nối: " + e.message, "error");
        setBtnLoading(targetBtn, false);
      }
    }
  </script>
</body>
</html>`;
}
