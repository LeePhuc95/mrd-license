/**
 * Cloudflare Worker: Hệ Thống Bản Quyền MRD Team
 * - Thống kê toàn diện mọi lượt đọc/ghi/truy cập của License (Trần: 50.000 req)
 * - Widget hiển thị số req License đã dùng và số lượng còn lại
 * - Phân mảnh tĩnh theo tiền tố (Prefix Chunking/Sharding): /{prefix}.json
 *   Mã hóa XOR với khóa 1012 -> Hex
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

    const cache = caches.default;
    const cacheKey = new Request(`${url.origin}/api/blocklist`, { method: "GET" });

    // =========================================================================
    // 1. ENDPOINT ANDROID: ĐỌC BLOCKLIST (CÓ CDN CACHE)
    // =========================================================================
    if (url.pathname === "/api/blocklist" && request.method === "GET") {
      let cachedResponse = await cache.match(cacheKey);
      if (cachedResponse) return cachedResponse;

      const { results } = await env.DB.prepare(
        "SELECT serial, rom_version FROM licenses WHERE key_status != 'OK'"
      ).all();

      const blockedList = (results || []).map(r => `${r.serial}_${r.rom_version}`);
      const newResponse = new Response(JSON.stringify({
        server_time: Math.floor(Date.now() / 1000),
        blocked_devices: blockedList
      }), {
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "public, max-age=86400"
        }
      });

      ctx.waitUntil(cache.put(cacheKey, newResponse.clone()));
      return newResponse;
    }

    // =========================================================================
    // 1.5. ENDPOINT ANDROID: PHÂN MẢNH SHARD STATIC JSON (PREFIX CHUNKING CÓ CDN CACHE)
    // Hỗ trợ cả /<prefix>.json và /api/chunks/<prefix>.json
    // =========================================================================
    const shardMatch = url.pathname.match(/^\/(?:api\/chunks\/)?([a-z0-9+/=_-]{1,10})\.json$/i);
    if (shardMatch && request.method === "GET") {
      const prefix = shardMatch[1].toLowerCase();
      const chunkCacheKey = new Request(`${url.origin}/${prefix}.json`, { method: "GET" });

      let cachedResponse = await cache.match(chunkCacheKey);
      if (cachedResponse) {
        return cachedResponse;
      }

      await ensureDbSchema(env);

      let { results } = await env.DB.prepare(
        "SELECT serial, rom_version, key_status, prefix FROM licenses WHERE prefix = ?"
      ).bind(prefix).all();

      let records = results || [];

      // Nếu chưa có bản ghi theo prefix (do dữ liệu cũ chưa đánh index prefix), kiểm tra và backfill
      if (records.length === 0) {
        const unindexed = await env.DB.prepare(
          "SELECT serial, rom_version, key_status, prefix FROM licenses WHERE prefix IS NULL"
        ).all();
        if (unindexed.results && unindexed.results.length > 0) {
          const matched = [];
          for (const row of unindexed.results) {
            const p = getDevicePrefix(row.serial);
            if (p === prefix) {
              matched.push(row);
              ctx.waitUntil(
                env.DB.prepare("UPDATE licenses SET prefix = ? WHERE serial = ?").bind(p, row.serial).run().catch(() => { })
              );
            }
          }
          records = matched;
        }
      }

      // Định dạng dữ liệu: SERIAL:ROM_VERSION:KEY_STATUS mã hóa XOR khóa 1012 -> Hex
      const encryptedList = records.map(r => {
        const raw = `${r.serial}:${r.rom_version}:${r.key_status}`;
        return xorEncryptHex(raw, "1012");
      });

      const response = new Response(JSON.stringify(encryptedList), {
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "public, max-age=86400, s-maxage=604800"
        }
      });

      ctx.waitUntil(cache.put(chunkCacheKey, response.clone()));
      return response;
    }

    // =========================================================================
    // 2. ENDPOINT ANDROID: KÍCH HOẠT THIẾT BỊ
    // =========================================================================
    if (url.pathname === "/api/activate" && request.method === "POST") {
      try {
        const { serial, rom_version } = await request.json();
        if (!serial || !rom_version) {
          return jsonResponse({ success: false, message: "Thiếu Serial hoặc ROM Version" }, 400);
        }

        const device = await env.DB.prepare(
          "SELECT * FROM licenses WHERE serial = ? AND rom_version = ?"
        ).bind(serial, rom_version).first();

        if (!device) {
          return jsonResponse({ success: false, message: "Thiết bị chưa được đăng ký trong hệ thống" }, 404);
        }

        if (device.key_status !== "OK") {
          return jsonResponse({ success: false, message: "Bản quyền đang bị ngưng hoặc đã xóa" }, 403);
        }

        if (device.gmail_notify === "NONE" && device.email_phone && device.email_phone.includes("@")) {
          ctx.waitUntil(sendMailAndUpdateStatus(env, device));
        }

        return jsonResponse({ success: true, status: "OK", token: `LIC_${serial}_${rom_version}_OK` });
      } catch (err) {
        return jsonResponse({ success: false, error: err.message }, 500);
      }
    }

    // =========================================================================
    // 3. API ADMIN
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

      // Truy vấn đồng thời dữ liệu bản quyền và dữ liệu request thực tế
      const [licensesRes, romsRes, statsRes] = await Promise.all([
        env.DB.prepare("SELECT * FROM licenses ORDER BY stt DESC").all(),
        env.DB.prepare("SELECT * FROM rom_categories ORDER BY name ASC").all(),
        env.DB.prepare("SELECT req_count FROM system_stats WHERE date_key = ? AND service_type = 'LICENSE'").bind(today).first()
      ]);

      const licenseUsage = statsRes ? (statsRes.req_count || 0) : 0;
      const licensesList = (licensesRes.results || []).map(item => ({
        ...item,
        prefix: item.prefix || getDevicePrefix(item.serial)
      }));

      return jsonResponse({
        licenses: licensesList,
        rom_categories: (romsRes.results || []).map(r => r.name),
        pages_domain: env.PAGES_DOMAIN ? env.PAGES_DOMAIN.replace(/\/+$/, '') : '',
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

      if (action === "create_license") {
        const { serial, rom_version, key_status, email_phone, country, note } = body;

        const existing = await env.DB.prepare(
          "SELECT stt FROM licenses WHERE serial = ? AND rom_version = ?"
        ).bind(serial, rom_version).first();

        if (existing) {
          return jsonResponse({
            success: false,
            error: `Thiết bị có Serial "${serial}" và ROM "${rom_version}" đã tồn tại trong hệ thống (STT: ${existing.stt})!`
          }, 400);
        }

        await ensureDbSchema(env);
        const prefix = getDevicePrefix(serial);

        await env.DB.prepare(
          `INSERT INTO licenses (serial, rom_version, key_status, email_phone, country, gmail_notify, note, created_at, prefix)
           VALUES (?, ?, ?, ?, ?, 'NONE', ?, ?, ?)`
        ).bind(serial, rom_version, key_status || 'OK', email_phone || '', country || 'VN', note || '', Date.now(), prefix).run();

        // Xóa CDN cache cục bộ cho prefix phân mảnh
        await cache.delete(new Request(`${url.origin}/${prefix}.json`, { method: "GET" }));

        // Tự động đẩy file phân mảnh lên GitHub Repo cho Cloudflare Pages
        const gitRes = await syncShardToGitHub(env, prefix);
        let msg = "Đã thêm thành công!";
        if (gitRes && gitRes.success) {
          msg += ` (Đã lưu ${prefix}.json lên GitHub)`;
        } else if (gitRes && !gitRes.success) {
          msg += ` (Lưu ý GitHub: ${gitRes.error})`;
        }

        return jsonResponse({ success: true, message: msg, prefix });
      }
      else if (action === "update_license") {
        const { stt, serial, rom_version, key_status, email_phone, country, note } = body;

        const duplicate = await env.DB.prepare(
          "SELECT stt FROM licenses WHERE serial = ? AND rom_version = ? AND stt != ?"
        ).bind(serial, rom_version, stt).first();

        if (duplicate) {
          return jsonResponse({
            success: false,
            error: `Không thể lưu! Serial "${serial}" và ROM "${rom_version}" đã thuộc về mục khác (STT: ${duplicate.stt}).`
          }, 400);
        }

        await ensureDbSchema(env);
        const oldItem = await env.DB.prepare("SELECT serial, prefix FROM licenses WHERE stt = ?").bind(stt).first();
        const oldPrefix = oldItem?.prefix || (oldItem ? getDevicePrefix(oldItem.serial) : null);
        const newPrefix = getDevicePrefix(serial);

        await env.DB.prepare(
          `UPDATE licenses SET serial = ?, rom_version = ?, key_status = ?, email_phone = ?, country = ?, note = ?, prefix = ?
           WHERE stt = ?`
        ).bind(serial, rom_version, key_status, email_phone || '', country, note || '', newPrefix, stt).run();

        await cache.delete(cacheKey);

        // Xóa CDN cache phân mảnh cũ và mới & đồng bộ lên GitHub
        let gitNotice = "";
        if (oldPrefix) {
          await cache.delete(new Request(`${url.origin}/${oldPrefix}.json`, { method: "GET" }));
          if (oldPrefix !== newPrefix) {
            await syncShardToGitHub(env, oldPrefix);
          }
        }
        if (newPrefix) {
          await cache.delete(new Request(`${url.origin}/${newPrefix}.json`, { method: "GET" }));
          const gitRes = await syncShardToGitHub(env, newPrefix);
          if (gitRes && !gitRes.success) {
            gitNotice = ` (Lưu ý GitHub: ${gitRes.error})`;
          }
        }

        return jsonResponse({ success: true, message: `Đã cập nhật thành công!${gitNotice}`, prefix: newPrefix });
      }
      else if (action === "delete_license") {
        const oldItem = await env.DB.prepare("SELECT serial, prefix FROM licenses WHERE stt = ?").bind(body.stt).first();
        const prefix = oldItem?.prefix || (oldItem ? getDevicePrefix(oldItem.serial) : null);

        await env.DB.prepare("DELETE FROM licenses WHERE stt = ?").bind(body.stt).run();
        await cache.delete(cacheKey);

        let gitNotice = "";
        if (prefix) {
          await cache.delete(new Request(`${url.origin}/${prefix}.json`, { method: "GET" }));
          const gitRes = await syncShardToGitHub(env, prefix);
          if (gitRes && !gitRes.success) {
            gitNotice = ` (Lưu ý GitHub: ${gitRes.error})`;
          }
        }
        return jsonResponse({ success: true, message: `Đã xóa bản quyền thành công!${gitNotice}` });
      }
      else if (action === "reindex_all_prefixes") {
        await ensureDbSchema(env);
        const { results } = await env.DB.prepare("SELECT stt, serial FROM licenses").all();
        let count = 0;
        const purgedPrefixes = new Set();
        for (const row of (results || [])) {
          const p = getDevicePrefix(row.serial);
          await env.DB.prepare("UPDATE licenses SET prefix = ? WHERE stt = ?").bind(p, row.stt).run();
          count++;
          purgedPrefixes.add(p);
          await cache.delete(new Request(`${url.origin}/${p}.json`, { method: "GET" }));
        }

        // Đẩy tất cả các shard phân mảnh lên GitHub Repo cho Pages và thu thập kết quả
        const syncMsgs = [];
        for (const p of purgedPrefixes) {
          const res = await syncShardToGitHub(env, p);
          if (res && res.success) {
            syncMsgs.push(`${p}.json: ✅ Thành công`);
          } else {
            syncMsgs.push(`${p}.json: ❌ ${res ? res.error : 'Lỗi không xác định'}`);
          }
        }

        const gitStatus = syncMsgs.length > 0 ? " | GitHub: " + syncMsgs.join("; ") : "";
        return jsonResponse({ success: true, count, message: `Đã đồng bộ ${count} bản ghi D1.${gitStatus}` });
      }
      else if (action === "add_rom") {
        const { name } = body;
        if (!name) return jsonResponse({ error: "Tên ROM không được để trống" }, 400);
        await env.DB.prepare("INSERT OR IGNORE INTO rom_categories (name) VALUES (?)").bind(name.trim()).run();
      }
      else if (action === "delete_rom") {
        await env.DB.prepare("DELETE FROM rom_categories WHERE name = ?").bind(body.name).run();
      }
      else if (action === "resend_mail") {
        const item = await env.DB.prepare("SELECT * FROM licenses WHERE stt = ?").bind(body.stt).first();
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
              secret: env.INTERNAL_SECRET || "matkhaucuatoi",
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
            await env.DB.prepare("UPDATE licenses SET gmail_notify = 'SENT' WHERE stt = ?").bind(item.stt).run();
            return jsonResponse({ success: true, ref_id: gasJson.ref_id });
          } else {
            await env.DB.prepare("UPDATE licenses SET gmail_notify = 'ERROR' WHERE stt = ?").bind(item.stt).run();
            return jsonResponse({ success: false, error: gasJson.error || gasText });
          }
        } catch (callErr) {
          await env.DB.prepare("UPDATE licenses SET gmail_notify = 'ERROR' WHERE stt = ?").bind(item.stt).run();
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
async function ensureDbSchema(env) {
  if (schemaChecked || !env?.DB) return;
  try {
    await env.DB.prepare("ALTER TABLE licenses ADD COLUMN prefix TEXT").run();
  } catch (e) {
    // Cột đã tồn tại, bỏ qua lỗi
  }
  try {
    await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_licenses_prefix ON licenses(prefix)").run();
  } catch (e) {
    // Bỏ qua lỗi index
  }
  schemaChecked = true;
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

    // Format: SERIAL:ROM_VERSION:KEY_STATUS -> XOR encrypt với khóa "1012" -> Hex
    const encryptedList = records.map(r => {
      const raw = `${r.serial}:${r.rom_version}:${r.key_status}`;
      return xorEncryptHex(raw, "1012");
    });

    const fileContent = JSON.stringify(encryptedList, null, 2);
    let binary = "";
    const encoder = new TextEncoder();
    const utf8Bytes = encoder.encode(fileContent);
    for (let i = 0; i < utf8Bytes.length; i++) {
      binary += String.fromCharCode(utf8Bytes[i]);
    }
    const contentBase64 = btoa(binary);

    const filePath = `${prefix}.json`;
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
      } catch (_) {}
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
 * Thuật toán băm phân mảnh:
 * HW_HASH=$(md5sum $SERI | xxd -r -p | base64)
 * PREFIX=$(echo "$HW_HASH" | cut -c 1-3 | tr '[:upper:]' '[:lower:]')
 */
function getDevicePrefix(serial) {
  if (!serial) return "unk";
  const rawBytes = md5(String(serial).trim());
  let binary = "";
  for (let i = 0; i < rawBytes.length; i++) {
    binary += String.fromCharCode(rawBytes[i]);
  }
  const b64 = btoa(binary);
  return b64.substring(0, 3).toLowerCase();
}

/**
 * Mã hóa chuỗi text bằng XOR với khóa lặp tuần hoàn (mặc định "1012"), xuất ra Hex
 */
function xorEncryptHex(text, key = "1012") {
  const encoder = new TextEncoder();
  const textBytes = encoder.encode(text);
  const keyBytes = encoder.encode(key);
  let hex = "";
  for (let i = 0; i < textBytes.length; i++) {
    const b = textBytes[i] ^ keyBytes[i % keyBytes.length];
    hex += b.toString(16).padStart(2, "0");
  }
  return hex;
}

/**
 * Thuật toán MD5 tiêu chuẩn (RFC 1321) thuần JavaScript - xuất ra mảng Uint8Array 16 bytes
 */
function md5(string) {
  function md5cycle(x, k) {
    var a = x[0], b = x[1], c = x[2], d = x[3];
    a = ff(a, b, c, d, k[0], 7, -680876936);
    d = ff(d, a, b, c, k[1], 12, -389564586);
    c = ff(c, d, a, b, k[2], 17, 606105819);
    b = ff(b, c, d, a, k[3], 22, -1044525330);
    a = ff(a, b, c, d, k[4], 7, -176418897);
    d = ff(d, a, b, c, k[5], 12, 1200080426);
    c = ff(c, d, a, b, k[6], 17, -1473231341);
    b = ff(b, c, d, a, k[7], 22, -45705983);
    a = ff(a, b, c, d, k[8], 7, 1770035416);
    d = ff(d, a, b, c, k[9], 12, -1958414417);
    c = ff(c, d, a, b, k[10], 17, -42063);
    b = ff(b, c, d, a, k[11], 22, -1990404162);
    a = ff(a, b, c, d, k[12], 7, 1804603682);
    d = ff(d, a, b, c, k[13], 12, -40341101);
    c = ff(c, d, a, b, k[14], 17, -1502002290);
    b = ff(b, c, d, a, k[15], 22, 1236535329);
    a = gg(a, b, c, d, k[1], 5, -165796510);
    d = gg(d, a, b, c, k[6], 9, -1069501632);
    c = gg(c, d, a, b, k[11], 14, 643717713);
    b = gg(b, c, d, a, k[0], 20, -373897302);
    a = gg(a, b, c, d, k[5], 5, -701558691);
    d = gg(d, a, b, c, k[10], 9, 38016083);
    c = gg(c, d, a, b, k[15], 14, -660478335);
    b = gg(b, c, d, a, k[4], 20, -405537848);
    a = gg(a, b, c, d, k[9], 5, 568446438);
    d = gg(d, a, b, c, k[14], 9, -1019803690);
    c = gg(c, d, a, b, k[3], 14, -187363961);
    b = gg(b, c, d, a, k[8], 20, 1163531501);
    a = gg(a, b, c, d, k[13], 5, -1444681467);
    d = gg(d, a, b, c, k[2], 9, -51403784);
    c = gg(c, d, a, b, k[7], 14, 1735328473);
    b = gg(b, c, d, a, k[12], 20, -1926607734);
    a = hh(a, b, c, d, k[5], 4, -378558);
    d = hh(d, a, b, c, k[8], 11, -2022574463);
    c = hh(c, d, a, b, k[11], 16, 1839030562);
    b = hh(b, c, d, a, k[14], 23, -35309556);
    a = hh(a, b, c, d, k[1], 4, -1530992060);
    d = hh(d, a, b, c, k[4], 11, 1272893353);
    c = hh(c, d, a, b, k[7], 16, -155497632);
    b = hh(b, c, d, a, k[10], 23, -1094730640);
    a = hh(a, b, c, d, k[13], 4, 681279174);
    d = hh(d, a, b, c, k[0], 11, -358537222);
    c = hh(c, d, a, b, k[3], 16, -722521979);
    b = hh(b, c, d, a, k[6], 23, 76029189);
    a = hh(a, b, c, d, k[9], 4, -640364487);
    d = hh(d, a, b, c, k[12], 11, -421815835);
    c = hh(c, d, a, b, k[15], 16, 530742520);
    b = hh(b, c, d, a, k[2], 23, -995338651);
    a = ii(a, b, c, d, k[0], 6, -198630844);
    d = ii(d, a, b, c, k[7], 10, 1126891415);
    c = ii(c, d, a, b, k[14], 15, -1416354905);
    b = ii(b, c, d, a, k[5], 21, -57434055);
    a = ii(a, b, c, d, k[12], 6, 1700485571);
    d = ii(d, a, b, c, k[3], 10, -1894986606);
    c = ii(c, d, a, b, k[10], 15, -1051523);
    b = ii(b, c, d, a, k[1], 21, -2054922799);
    a = ii(a, b, c, d, k[8], 6, 1873313359);
    d = ii(d, a, b, c, k[15], 10, -30611744);
    c = ii(c, d, a, b, k[6], 15, -1560198380);
    b = ii(b, c, d, a, k[13], 21, 1309151649);
    a = ii(a, b, c, d, k[4], 6, -145523070);
    d = ii(d, a, b, c, k[11], 10, -1120210379);
    c = ii(c, d, a, b, k[2], 15, 718787259);
    b = ii(b, c, d, a, k[9], 21, -343485551);
    x[0] = add32(a, x[0]);
    x[1] = add32(b, x[1]);
    x[2] = add32(c, x[2]);
    x[3] = add32(d, x[3]);
  }
  function cmn(q, a, b, x, s, t) {
    a = add32(add32(a, q), add32(x, t));
    return add32((a << s) | (a >>> (32 - s)), b);
  }
  function ff(a, b, c, d, x, s, t) { return cmn((b & c) | ((~b) & d), a, b, x, s, t); }
  function gg(a, b, c, d, x, s, t) { return cmn((b & d) | (c & (~d)), a, b, x, s, t); }
  function hh(a, b, c, d, x, s, t) { return cmn(b ^ c ^ d, a, b, x, s, t); }
  function ii(a, b, c, d, x, s, t) { return cmn(c ^ (b | (~d)), a, b, x, s, t); }
  function add32(a, b) { return (a + b) & 0xFFFFFFFF; }

  function md51(s) {
    var n = s.length, state = [1732584193, -271733879, -1732584194, 271733878], i;
    for (i = 64; i <= s.length; i += 64) {
      md5cycle(state, md5blk(s.substring(i - 64, i)));
    }
    s = s.substring(i - 64);
    var tail = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    for (i = 0; i < s.length; i++) tail[i >> 2] |= s.charCodeAt(i) << ((i % 4) << 3);
    tail[i >> 2] |= 0x80 << ((i % 4) << 3);
    if (i > 55) {
      md5cycle(state, tail);
      for (i = 0; i < 16; i++) tail[i] = 0;
    }
    tail[14] = n * 8;
    md5cycle(state, tail);
    return state;
  }

  function md5blk(s) {
    var md5blks = [], i;
    for (i = 0; i < 64; i += 4) {
      md5blks[i >> 2] = s.charCodeAt(i)
        + (s.charCodeAt(i + 1) << 8)
        + (s.charCodeAt(i + 2) << 16)
        + (s.charCodeAt(i + 3) << 24);
    }
    return md5blks;
  }

  function rawBytes(words) {
    var bytes = [];
    for (var i = 0; i < words.length; i++) {
      for (var j = 0; j < 4; j++) {
        bytes.push((words[i] >>> (j * 8)) & 0xFF);
      }
    }
    return new Uint8Array(bytes);
  }

  return rawBytes(md51(string));
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
      await env.DB.prepare("UPDATE licenses SET gmail_notify = 'SENT' WHERE stt = ?").bind(device.stt).run();
    } else {
      await env.DB.prepare("UPDATE licenses SET gmail_notify = 'ERROR' WHERE stt = ?").bind(device.stt).run();
    }
  } catch (err) {
    await env.DB.prepare("UPDATE licenses SET gmail_notify = 'ERROR' WHERE stt = ?").bind(device.stt).run();
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
  <title>MRD Team - Quản Lý Bản Quyền</title>
  <style>
    :root[data-theme="light"] {
      --bg-body: #f1f5f9;
      --bg-card: #ffffff;
      --text-main: #0f172a;
      --text-muted: #64748b;
      --border-color: #e2e8f0;
      --table-header: #f8fafc;
      --table-hover: #f1f5f9;
      --sidebar-bg: #0f172a;
      --sidebar-text: #94a3b8;
      --sidebar-active: #1e293b;
      --modal-overlay: rgba(15, 23, 42, 0.7);
    }

    :root[data-theme="dark"] {
      --bg-body: #0b0f19;
      --bg-card: #151c2c;
      --text-main: #f8fafc;
      --text-muted: #94a3b8;
      --border-color: #26334d;
      --table-header: #1a2337;
      --table-hover: #1e293b;
      --sidebar-bg: #070a12;
      --sidebar-text: #64748b;
      --sidebar-active: #151c2c;
      --modal-overlay: rgba(0, 0, 0, 0.85);
    }

    * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; margin: 0; padding: 0; }
    body { background: var(--bg-body); color: var(--text-main); display: flex; height: 100vh; overflow: hidden; transition: background 0.25s, color 0.25s; }

    #authOverlay {
      position: fixed; top: 0; left: 0; width: 100%; height: 100%;
      background: rgba(10, 15, 26, 0.96); backdrop-filter: blur(8px);
      display: flex; align-items: center; justify-content: center; z-index: 9999; padding: 20px;
    }
    .auth-card {
      background: var(--bg-card); padding: 30px; border-radius: 12px; width: 100%; max-width: 380px;
      box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.5); text-align: center; border: 1px solid var(--border-color);
    }
    .auth-card h3 { margin-bottom: 8px; color: var(--text-main); font-size: 20px; }
    .auth-card p { color: var(--text-muted); font-size: 13px; margin-bottom: 20px; }
    .auth-card input {
      width: 100%; padding: 12px; border: 1px solid var(--border-color); border-radius: 6px;
      background: var(--bg-body); color: var(--text-main); font-size: 15px; margin-bottom: 16px; outline: none;
    }
    .auth-card button {
      width: 100%; padding: 12px; background: #2563eb; color: #fff; font-weight: bold;
      border: none; border-radius: 6px; cursor: pointer; font-size: 15px;
    }

    .sidebar {
      width: 250px; background: var(--sidebar-bg); color: #fff; display: flex; flex-direction: column;
      flex-shrink: 0; z-index: 50; transition: transform 0.3s ease;
    }
    .brand { padding: 20px; font-size: 18px; font-weight: bold; border-bottom: 1px solid var(--border-color); color: #38bdf8; display: flex; justify-content: space-between; align-items: center; }
    .nav-list { list-style: none; padding: 15px 0; flex: 1; }
    .nav-item {
      padding: 14px 20px; cursor: pointer; font-size: 14px; font-weight: 500;
      color: var(--sidebar-text); display: flex; align-items: center; gap: 10px; transition: 0.2s;
    }
    .nav-item:hover, .nav-item.active { background: var(--sidebar-active); color: #fff; border-left: 4px solid #38bdf8; }
    .sidebar-footer { padding: 15px 16px; display: flex; flex-direction: column; gap: 8px; border-top: 1px solid var(--border-color); }
    .btn-logout { background: none; border: none; color: #ef4444; font-size: 13px; font-weight: 600; cursor: pointer; text-align: left; padding: 4px 0; }

    /* KHỐI HIỂN THỊ QUOTA BẢN QUYỀN */
    .quota-box {
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 8px;
      padding: 10px 12px;
      margin-bottom: 6px;
    }
    .quota-title {
      font-size: 11px;
      color: #94a3b8;
      font-weight: 600;
      display: flex;
      justify-content: space-between;
      margin-bottom: 4px;
    }
    .quota-number {
      font-size: 13px;
      font-weight: bold;
      color: #38bdf8;
    }
    .quota-sub {
      font-size: 11px;
      color: #64748b;
      margin-top: 2px;
    }
    .quota-bar-bg {
      background: rgba(255, 255, 255, 0.12);
      border-radius: 4px;
      height: 5px;
      width: 100%;
      overflow: hidden;
      margin-top: 6px;
    }
    .quota-bar-fill {
      height: 100%;
      background: #38bdf8;
      border-radius: 4px;
      transition: width 0.3s;
    }

    .content-area { 
      flex: 1; display: flex; flex-direction: column; 
      overflow-y: auto; overflow-x: hidden; min-width: 0; width: 100%; 
    }
    .topbar {
      background: var(--bg-card); padding: 14px 20px; border-bottom: 1px solid var(--border-color);
      display: flex; justify-content: space-between; align-items: center; flex-shrink: 0;
    }
    .topbar-left { display: flex; align-items: center; gap: 12px; }
    .menu-toggle-btn { display: none; background: none; border: none; font-size: 20px; color: var(--text-main); cursor: pointer; }
    .theme-toggle-btn {
      background: var(--bg-body); border: 1px solid var(--border-color); color: var(--text-main);
      padding: 7px 12px; border-radius: 6px; cursor: pointer; font-size: 13px; font-weight: 500;
    }

    .tab-content { display: none; padding: 20px; width: 100%; max-width: 1400px; margin: 0 auto; }
    .tab-content.active { display: block; }

    .card {
      background: var(--bg-card); border-radius: 10px; border: 1px solid var(--border-color);
      padding: 20px; box-shadow: 0 1px 3px 0 rgba(0, 0, 0, 0.05);
    }
    .table-container { overflow-x: auto; width: 100%; border-radius: 6px; border: 1px solid var(--border-color); }
    table { width: 100%; border-collapse: collapse; text-align: left; font-size: 13px; }
    th, td { padding: 12px 14px; border-bottom: 1px solid var(--border-color); white-space: nowrap; }
    th { background: var(--table-header); color: var(--text-muted); font-weight: 600; text-transform: uppercase; font-size: 11px; letter-spacing: 0.5px; }
    tbody tr { cursor: pointer; transition: background 0.15s; }
    tbody tr:hover { background: var(--table-hover); }

    .badge { padding: 3px 8px; border-radius: 20px; font-size: 11px; font-weight: 600; display: inline-block; }
    .badge-OK { background: #dcfce7; color: #166534; }
    .badge-OFF { background: #fef9c3; color: #854d0e; }
    .badge-DEL { background: #fee2e2; color: #991b1b; }
    .badge-SENT { background: #e0f2fe; color: #0369a1; }
    .badge-ERROR { background: #fef2f2; color: #dc2626; }
    .badge-NONE { background: #f1f5f9; color: #64748b; }
    .badge-shard { background: #0284c7; color: #ffffff; font-family: monospace; font-size: 11px; }

    .form-group { margin-bottom: 14px; }
    .form-group label { display: block; font-size: 12px; font-weight: 600; color: var(--text-muted); margin-bottom: 6px; text-transform: uppercase; }
    .form-group input, .form-group select {
      width: 100%; padding: 10px 12px; border: 1px solid var(--border-color); border-radius: 6px;
      background: var(--bg-body); color: var(--text-main); font-size: 14px; outline: none; transition: border-color 0.2s;
    }
    .form-group input:focus, .form-group select:focus { border-color: #2563eb; }
    .form-group input:disabled, .form-group select:disabled { opacity: 0.7; cursor: not-allowed; }

    .btn { padding: 9px 16px; border: none; border-radius: 6px; cursor: pointer; font-weight: 600; font-size: 13px; transition: 0.2s; display: inline-flex; align-items: center; justify-content: center; gap: 6px; }
    .btn-blue { background: #2563eb; color: #fff; }
    .btn-green { background: #16a34a; color: #fff; }
    .btn-red { background: #dc2626; color: #fff; }
    .btn-gray { background: #64748b; color: #fff; }
    .btn:hover { opacity: 0.9; }

    .modal-backdrop {
      position: fixed; top: 0; left: 0; width: 100%; height: 100%;
      background: var(--modal-overlay); backdrop-filter: blur(4px);
      display: none; align-items: center; justify-content: center; z-index: 10000; padding: 15px;
    }
    .modal-box {
      background: var(--bg-card); border: 1px solid var(--border-color); border-radius: 12px;
      width: 100%; max-width: 520px; max-height: 90vh; overflow-y: auto; padding: 24px;
      box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.4);
    }
    .modal-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }
    .modal-header h3 { font-size: 17px; }
    .close-btn { font-size: 20px; cursor: pointer; color: var(--text-muted); }
    .modal-footer { display: flex; justify-content: flex-end; gap: 10px; margin-top: 20px; border-top: 1px solid var(--border-color); padding-top: 16px; }

    #toastContainer { position: fixed; top: 20px; right: 20px; z-index: 10001; display: flex; flex-direction: column; gap: 10px; }
    .toast-msg {
      background: var(--bg-card); color: var(--text-main); border: 1px solid var(--border-color);
      padding: 12px 18px; border-radius: 8px; font-size: 13px; font-weight: 500;
      box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.2); animation: slideIn 0.3s ease;
      display: flex; align-items: center; gap: 8px; max-width: 350px;
    }
    .toast-success { border-left: 4px solid #16a34a; }
    .toast-error { border-left: 4px solid #dc2626; }
    .toast-warn { border-left: 4px solid #f59e0b; }
    .toast-info { border-left: 4px solid #2563eb; }
    @keyframes slideIn { from { transform: translateX(100%); opacity: 0; } to { transform: translateX(0); opacity: 1; } }

    .sidebar-backdrop { display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.5); z-index: 40; }

    @media (max-width: 768px) {
      .sidebar { position: fixed; top: 0; left: 0; height: 100%; transform: translateX(-100%); }
      .sidebar.open { transform: translateX(0); }
      .sidebar-backdrop.open { display: block; }
      .menu-toggle-btn { display: inline-block; }
      .brand span:last-child { display: inline-block !important; }
      .tab-content { padding: 12px; }
    }

    #confirmOverlay {
      position: fixed; top: 0; left: 0; width: 100%; height: 100%;
      background: var(--modal-overlay); backdrop-filter: blur(4px);
      display: none; align-items: center; justify-content: center; z-index: 10002; padding: 15px;
    }
    .confirm-card {
      background: var(--bg-card); border: 1px solid var(--border-color); border-radius: 12px;
      width: 100%; max-width: 400px; padding: 24px; box-shadow: 0 20px 25px -5px rgba(0,0,0,0.4);
      text-align: center; animation: scalePop 0.2s ease;
    }
    @keyframes scalePop {
      from { transform: scale(0.92); opacity: 0; }
      to   { transform: scale(1); opacity: 1; }
    }
    .confirm-card h4 { font-size: 18px; margin-bottom: 8px; color: var(--text-main); }
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
      <span>MRD Team</span>
      <span style="font-size: 12px; cursor: pointer; color: #94a3b8; display: none;" id="closeSidebarBtn" onclick="toggleSidebar(false)">✕</span>
    </div>
    <ul class="nav-list">
      <li class="nav-item active" onclick="switchTab('listTab', this)">📋 Danh sách</li>
      <li class="nav-item" onclick="switchTab('createTab', this)">➕ Tạo mới</li>
      <li class="nav-item" onclick="switchTab('romTab', this)">📁 Danh mục ROM</li>
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
        <div style="font-size: 17px; font-weight: bold;" id="topbarTitle">Danh sách Bản quyền</div>
        <button class="btn btn-blue" style="margin-left: 8px; padding: 6px 12px; font-size: 12px;" onclick="handleSyncAllPrefixes()" title="Tính toán lại Prefix và đồng bộ cache phân mảnh">🔄 Đồng bộ Shards</button>
      </div>
      <button class="theme-toggle-btn" id="themeBtn" onclick="toggleTheme()">🌙 Giao diện</button>
    </div>

    <!-- TAB 1: DANH SÁCH -->
    <div id="listTab" class="tab-content active">
      <div class="card">
        <div class="table-container">
          <table>
            <thead>
              <tr>
                <th>STT</th>
                <th>SHARD (FILE)</th>
                <th>SERIAL</th>
                <th>ROM_VERSION</th>
                <th>KEY_STATUS</th>
                <th>EMAIL/PHONE</th>
                <th>COUNTRY</th>
                <th>GMAIL_NOTIFY</th>
                <th>NOTE</th>
              </tr>
            </thead>
            <tbody id="licenseTableBody">
              <tr><td colspan="9" style="text-align: center; color: var(--text-muted);">Đang tải dữ liệu...</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- TAB 2: TẠO MỚI -->
    <div id="createTab" class="tab-content">
      <div class="card" style="max-width: 550px; margin: auto;">
        <div class="form-group">
          <label>SERIAL (*)</label>
          <input type="text" id="addSerial" placeholder="Ví dụ: G6AY8400E7W">
        </div>
        <div class="form-group">
          <label>ROM_VERSION (*)</label>
          <select id="addRomSelect"></select>
        </div>
        <div class="form-group">
          <label>KEY_STATUS</label>
          <select id="addStatus">
            <option value="OK">OK (Kích hoạt)</option>
            <option value="OFF">OFF (Ngưng)</option>
            <option value="DEL">DEL (Xóa)</option>
          </select>
        </div>
        <div class="form-group">
          <label>EMAIL / PHONE</label>
          <input type="text" id="addEmail" placeholder="Nhập Email hoặc SĐT khách">
        </div>
        <div class="form-group">
          <label>COUNTRY</label>
          <select id="addCountry">
            <option value="VN">VN (Gửi mail tiếng Việt)</option>
            <option value="Other">Other (Gửi mail tiếng Anh)</option>
          </select>
        </div>
        <div class="form-group">
          <label>NOTE</label>
          <input type="text" id="addNote" placeholder="Ghi chú thiết bị/khách hàng">
        </div>
        <button class="btn btn-green" style="width: 100%;" onclick="handleCreateLicense()">+ Thêm Bản Quyền</button>
      </div>
    </div>

    <!-- TAB 3: DANH MỤC ROM -->
    <div id="romTab" class="tab-content">
      <div class="card" style="max-width: 600px; margin: 0 auto 20px auto;">
        <h4 style="margin-bottom: 12px;">Thêm Danh mục ROM</h4>
        <div style="display: flex; gap: 8px;">
          <input type="text" id="newRomName" placeholder="Tên bản ROM mới..." style="flex: 1; padding: 10px; border: 1px solid var(--border-color); border-radius: 6px; background: var(--bg-body); color: var(--text-main);">
          <button class="btn btn-blue" onclick="handleAddRom()">+ Thêm</button>
        </div>
      </div>
      <div class="card" style="max-width: 600px; margin: auto;">
        <h4 style="margin-bottom: 12px;">Danh sách ROM hiện tại</h4>
        <div class="table-container">
          <table>
            <thead><tr><th>Tên ROM</th><th style="width: 80px;">Xóa</th></tr></thead>
            <tbody id="romTableBody"></tbody>
          </table>
        </div>
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
      
      <input type="hidden" id="editStt">
      <div class="form-group">
        <label>SHARD TĨNH (PREFIX)</label>
        <div style="display: flex; gap: 10px; align-items: center;">
          <input type="text" id="editPrefix" disabled style="max-width: 140px; font-weight: bold; font-family: monospace;">
          <a id="editPrefixLink" href="#" target="_blank" class="btn btn-blue" style="text-decoration: none; font-size: 12px; padding: 9px 14px;">📂 Xem file JSON tĩnh</a>
        </div>
      </div>
      <div class="form-group">
        <label>SERIAL</label>
        <input type="text" id="editSerial" disabled>
      </div>
      <div class="form-group">
        <label>ROM_VERSION</label>
        <select id="editRomSelect" disabled></select>
      </div>
      <div class="form-group">
        <label>KEY_STATUS</label>
        <select id="editStatus" disabled>
          <option value="OK">OK (Kích hoạt)</option>
          <option value="OFF">OFF (Ngưng kích hoạt)</option>
          <option value="DEL">DEL (Xóa)</option>
        </select>
      </div>
      <div class="form-group">
        <label>EMAIL / PHONE</label>
        <input type="text" id="editEmail" disabled>
      </div>
      <div class="form-group">
        <label>COUNTRY</label>
        <select id="editCountry" disabled>
          <option value="VN">VN</option>
          <option value="Other">Other</option>
        </select>
      </div>
      <div class="form-group">
        <label>NOTE</label>
        <input type="text" id="editNote" disabled>
      </div>

      <div class="modal-footer" id="modalFooterView">
        <button type="button" class="btn btn-blue" id="btnSendMail" onclick="handleResendMailFromModal(this)">Gửi Email kích hoạt</button>
        <button type="button" class="btn btn-red" onclick="handleDeleteFromModal()">Xóa</button>
        <button type="button" class="btn btn-blue" onclick="toggleEditMode(true)">Chỉnh sửa</button>
        <button type="button" class="btn btn-gray" onclick="closeModal()">Đóng</button>
      </div>
      <div class="modal-footer" id="modalFooterEdit" style="display: none;">
        <button type="button" class="btn btn-green" onclick="handleSaveEdit()">Lưu</button>
        <button type="button" class="btn btn-gray" onclick="toggleEditMode(false)">Hủy</button>
      </div>
    </div>
  </div>

  <script>
    let currentAuthToken = "";
    let systemData = { licenses: [], rom_categories: [] };
    let currentSelectedItem = null;

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

    function initTheme() {
      const savedTheme = localStorage.getItem("mrd_theme") || "light";
      document.documentElement.setAttribute("data-theme", savedTheme);
      updateThemeButton(savedTheme);
    }

    function toggleTheme() {
      const currentTheme = document.documentElement.getAttribute("data-theme");
      const nextTheme = currentTheme === "dark" ? "light" : "dark";
      document.documentElement.setAttribute("data-theme", nextTheme);
      localStorage.setItem("mrd_theme", nextTheme);
      updateThemeButton(nextTheme);
    }

    function updateThemeButton(theme) {
      document.getElementById("themeBtn").innerText = theme === "dark" ? "☀️ Sáng" : "🌙 Tối";
    }
    initTheme();

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
        listTab: "Danh sách Bản quyền",
        createTab: "Tạo mới Bản quyền",
        romTab: "Quản lý Danh mục ROM"
      };
      document.getElementById("topbarTitle").innerText = titles[tabId];
      if (window.innerWidth <= 768) toggleSidebar(false);
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

      // CẬP NHẬT WIDGET ĐẾM REQUEST LICENSE
      if (systemData.license_quota) {
        const q = systemData.license_quota;
        const percent = ((q.remaining / q.limit) * 100).toFixed(0);
        
        document.getElementById("quotaRemainingText").innerText = 
          q.remaining.toLocaleString() + " / " + q.limit.toLocaleString();
        document.getElementById("quotaPercent").innerText = percent + "%";
        document.getElementById("quotaUsedText").innerText = 
          "Đã dùng hôm nay: " + q.used.toLocaleString() + " req";
        
        const bar = document.getElementById("quotaProgress");
        bar.style.width = percent + "%";
        
        if (percent <= 20) {
          bar.style.background = "#ef4444";
        } else if (percent <= 50) {
          bar.style.background = "#f59e0b";
        } else {
          bar.style.background = "#38bdf8";
        }
      }
    } catch (err) {
      showToast("Lỗi tải dữ liệu: " + err.message, "error");
    }
  }

  function renderLicenseTable() {
    const tbody = document.getElementById("licenseTableBody");
    if (!systemData.licenses.length) {
      tbody.innerHTML = '<tr><td colspan="9" style="text-align:center; color:var(--text-muted);">Chưa có bản ghi nào.</td></tr>';
      return;
    }

    const rawDomain = systemData.pages_domain || "";
    const pagesBase = rawDomain.endsWith("/") ? rawDomain.slice(0, -1) : rawDomain;
      tbody.innerHTML = systemData.licenses.map(item => {
        const linkHref = pagesBase ? (pagesBase + "/" + item.prefix + ".json") : ("/" + item.prefix + ".json");
        return \`
        <tr onclick="openDetailModal(\${item.stt})">
          <td>\${item.stt}</td>
          <td>
            <a href="\${linkHref}" target="_blank" onclick="event.stopPropagation()" title="Mở file JSON phân mảnh trên Cloudflare Pages" style="text-decoration:none;">
              <span class="badge badge-shard">🚀 \${item.prefix}.json</span>
            </a>
          </td>
          <td><b><code>\${item.serial}</code></b></td>
          <td><code>\${item.rom_version}</code></td>
          <td><span class="badge badge-\${item.key_status}">\${item.key_status}</span></td>
          <td>\${item.email_phone || "-"}</td>
          <td>\${item.country}</td>
          <td><span class="badge badge-\${item.gmail_notify}">\${item.gmail_notify}</span></td>
          <td>\${item.note || ""}</td>
        </tr>
      \`;
      }).join('');
    }

    function renderRomDropdowns() {
      const options = systemData.rom_categories.map(r => \`<option value="\${r}">\${r}</option>\`).join('');
      document.getElementById("addRomSelect").innerHTML = options;
      document.getElementById("editRomSelect").innerHTML = options;
    }

    function renderRomTable() {
      const tbody = document.getElementById("romTableBody");
      if (!systemData.rom_categories.length) {
        tbody.innerHTML = '<tr><td colspan="2" style="color:var(--text-muted);">Chưa có danh mục ROM.</td></tr>';
        return;
      }
      tbody.innerHTML = systemData.rom_categories.map(r => \`
        <tr>
          <td><b><code>\${r}</code></b></td>
          <td><button type="button" class="btn btn-red" style="padding:4px 8px;font-size:11px;" onclick="handleDeleteRom('\${r}')">Xóa</button></td>
        </tr>
      \`).join('');
    }

    function openDetailModal(stt) {
      currentSelectedItem = systemData.licenses.find(i => i.stt === stt);
      if (!currentSelectedItem) return;

      const prefix = currentSelectedItem.prefix || "unk";
      const rawDomain = systemData.pages_domain || "";
      const pagesBase = rawDomain.endsWith("/") ? rawDomain.slice(0, -1) : rawDomain;
      const linkHref = pagesBase ? (pagesBase + "/" + prefix + ".json") : ("/" + prefix + ".json");
      document.getElementById("editStt").value = currentSelectedItem.stt;
      document.getElementById("editPrefix").value = prefix + ".json";
      document.getElementById("editPrefixLink").href = linkHref;
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
      const payload = {
        action: "update_license",
        stt: parseInt(document.getElementById("editStt").value),
        serial: document.getElementById("editSerial").value.trim(),
        rom_version: document.getElementById("editRomSelect").value,
        key_status: document.getElementById("editStatus").value,
        email_phone: document.getElementById("editEmail").value.trim(),
        country: document.getElementById("editCountry").value,
        note: document.getElementById("editNote").value.trim()
      };

      const res = await sendAdminAction(payload);
      if (!res.success) {
        return showToast(res.error || "Không thể lưu thay đổi!", "error");
      }

      closeModal();
      await loadAllData();
      showToast("Đã lưu cập nhật thành công!", "success");
    }

    async function handleDeleteFromModal() {
      const serialName = currentSelectedItem ? currentSelectedItem.serial : "";
      const confirmed = await showConfirm(
        "Xác nhận xóa",
        'Bạn có chắc chắn muốn xóa vĩnh viễn thiết bị có Serial "' + serialName + '"?',
        true
      );
      if (confirmed) {
        await sendAdminAction({ action: "delete_license", stt: currentSelectedItem.stt });
        closeModal();
        await loadAllData();
        showToast("Đã xóa thiết bị thành công!", "success");
      }
    }

    async function handleCreateLicense() {
      const serial = document.getElementById("addSerial").value.trim();
      const rom_version = document.getElementById("addRomSelect").value;
      if (!serial) return showToast("Vui lòng nhập Serial!", "warn");

      const res = await sendAdminAction({
        action: "create_license",
        serial,
        rom_version,
        key_status: document.getElementById("addStatus").value,
        email_phone: document.getElementById("addEmail").value.trim(),
        country: document.getElementById("addCountry").value,
        note: document.getElementById("addNote").value.trim()
      });

      if (!res.success) {
        return showToast(res.error || "Không thể tạo bản ghi!", "error");
      }

      document.getElementById("addSerial").value = "";
      document.getElementById("addEmail").value = "";
      document.getElementById("addNote").value = "";
      showToast(res.message || ("Đã thêm thiết bị mới thành công (Shard: " + res.prefix + ".json)!"), "success", 6000);
      await loadAllData();
      switchTab('listTab', document.querySelectorAll('.nav-item')[0]);
    }

    async function handleSyncAllPrefixes() {
      const confirmed = await showConfirm(
        "Đồng bộ Shards tĩnh",
        "Hệ thống sẽ tính toán lại tiền tố (Prefix) cho toàn bộ license trong CSDL D1 và đồng bộ lên GitHub Repo. Bạn có muốn tiếp tục?",
        false
      );
      if (!confirmed) return;
      showToast("Đang đồng bộ dữ liệu Shards lên GitHub...", "info");
      const res = await sendAdminAction({ action: "reindex_all_prefixes" });
      if (res && res.success) {
        showToast(res.message || "Đã đồng bộ thành công!", "success", 8000);
        await loadAllData();
      } else {
        showToast("Lỗi đồng bộ: " + (res.error || "Không rõ"), "error", 8000);
      }
    }

    async function handleAddRom() {
      const name = document.getElementById("newRomName").value.trim();
      if (!name) return showToast("Vui lòng nhập tên ROM!", "warn");
      await sendAdminAction({ action: "add_rom", name });
      document.getElementById("newRomName").value = "";
      await loadAllData();
      showToast('Đã thêm danh mục ROM "' + name + '"', "success");
    }

    async function handleDeleteRom(name) {
      const confirmed = await showConfirm(
        "Xác nhận xóa danh mục",
        'Bạn có chắc chắn muốn xóa ROM "' + name + '"?',
        true
      );
      if (confirmed) {
        await sendAdminAction({ action: "delete_rom", name });
        await loadAllData();
        showToast('Đã xóa danh mục ROM "' + name + '"', "success");
      }
    }

    async function sendAdminAction(payload) {
      const res = await fetch("/api/admin/action", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + currentAuthToken },
        body: JSON.stringify(payload)
      });
      return await res.json();
    }

    async function handleResendMailFromModal(btn) {
      if (!currentSelectedItem) return;

      const emailVal = (currentSelectedItem.email_phone || "").trim();
      if (!emailVal.includes("@")) {
        return showToast("Mục này chưa có Email hợp lệ để gửi!", "warn");
      }

      const targetBtn = btn || document.getElementById("btnSendMail");
      let originalText = "Gửi Email kích hoạt";
      if (targetBtn) {
        originalText = targetBtn.innerHTML;
        targetBtn.innerHTML = "⏳ Đang gửi...";
        targetBtn.disabled = true;
      }

      showToast("Đang kích hoạt lệnh gửi mail...", "info");

      try {
        const res = await sendAdminAction({ action: "resend_mail", stt: currentSelectedItem.stt });
        
        if (res && res.success) {
          if (targetBtn) targetBtn.innerHTML = "✅ Đã gửi lệnh!";
          setTimeout(async () => {
            closeModal();
            await loadAllData();
            showToast("Đã gửi email thành công! Vui lòng kiểm tra hộp thư.", "success");
          }, 1000);
        } else {
          showToast("Lỗi gửi mail: " + (res.error || "Không gửi được"), "error");
          if (targetBtn) {
            targetBtn.innerHTML = originalText;
            targetBtn.disabled = false;
          }
        }
      } catch (e) {
        showToast("Lỗi kết nối: " + e.message, "error");
        if (targetBtn) {
          targetBtn.innerHTML = originalText;
          targetBtn.disabled = false;
        }
      }
    }
  </script>
</body>
</html>`;
}
