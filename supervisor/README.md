# Supervisor — Container Manager untuk Shared VM

Supervisor adalah satu-satunya proses di deployment ini yang memegang Docker socket. API server tidak pernah menyentuh socket tersebut; ia hanya boleh meminta empat hal yang diekspresikan dalam istilah Bot, bukan dalam istilah Docker:

- `ensure`: pastikan komputer untuk sebuah Bot ada dan siap dipakai.
- `stop`: hentikan komputer tanpa menghapus penyimpanannya.
- `reset`: hapus komputer beserta profile browser-nya.
- `list`: tampilkan komputer yang dimiliki deployment ini.

Karena socket Docker setara dengan root di host, supervisor tidak menyediakan passthrough atau perintah Docker generik. Nama container dan volume diturunkan dari Bot id yang sudah divalidasi, dan setiap operasi hanya menyentuh resource yang membawa label `openbot.supervisor=true` serta namespace deployment yang sama.

---

## 1. Arsitektur Shared Pool

Model biayanya adalah **shared compute pool, strict data isolation**:

```text
Mobile / API server
        |
        |  POST /computers/:botId/ensure
        v
   supervisor  ──────► Docker Engine
        |                   |
        |                   ├── container agent-computer untuk Bot A
        |                   │     └── /workspace ──► volume/path tenant A
        |                   |
        |                   └── container agent-computer untuk Bot B
        |                         └── /workspace ──► volume/path tenant B
        |
        └── resource CPU/RAM/browser dipakai bersama di satu host
```

Prinsipnya:

1. **Compute boleh dipakai bersama.** Satu image `agent-computer`, satu host Docker, dan container worker yang reaktif. Container tidak perlu dibuat ulang untuk setiap pesan; `ensure` bersifat idempoten dan memakai kembali container yang sudah ada selama image, token, tenant, dan target workspace-nya masih cocok.
2. **Data tenant tidak boleh tercampur.** Batas isolasi utama ada di lapisan mount, bukan di kernel. Setiap container hanya melihat `/workspace` milik tenant yang sedang dilayani dan `/profiles` milik Bot tersebut.
3. **Container adalah resource sementara.** `stop` mematikan container tetapi mempertahankan volume. `reset` menghapus container dan profile browser, sedangkan workspace karya pengguna tidak dihapus.
4. **Pool saat ini bersifat reaktif.** Container dibuat saat `ensure` pertama dipanggil, bukan dari antrean worker yang sudah dipanaskan sebelumnya. Antrean task dan pre-warmed pool dapat ditambahkan di atas kontrak `ensure` ini tanpa mengubah batas keamanan supervisor.

Setiap container juga membawa label:

| Label | Isi |
| --- | --- |
| `openbot.supervisor` | `true` untuk semua resource milik supervisor |
| `openbot.namespace` | Namespace deployment (`COMPUTER_NAMESPACE`) |
| `openbot.bot-id` | Bot pemilik container |
| `openbot.tenant-id` | Tenant yang dicatat saat `ensure` (opsional) |

---

## 2. Dynamic Tenant Workspace Mounting

Secara default, supervisor memasang volume per Bot:

```text
<namespace>-workspace-<botId>  →  /workspace
```

Untuk deployment multi-tenant, pemanggil `ensure` dapat mengganti target mount tersebut agar container yang sama melayani workspace tenant yang berbeda. Default hanya dipakai jika tidak ada override.

### Field body `POST /computers/:botId/ensure`

Semua field opsional:

| Field | Tipe | Arti |
| --- | --- | --- |
| `tenantId` | string | Identitas tenant untuk label container dan audit. Tidak mengubah nama resource. |
| `workspaceVolume` | string | Nama Docker volume yang di-mount ke `/workspace`, menggantikan volume default Bot. |
| `workspacePath` | string | Direktori host absolut yang di-bind-mount ke `/workspace`, menggantikan volume default Bot. |

Aturan:

- `workspaceVolume` dan `workspacePath` saling eksklusif. Mengirim keduanya menghasilkan `400`.
- `workspaceVolume` harus berupa nama volume Docker yang valid (`[A-Za-z0-9][A-Za-z0-9_.-]*`). Jika volume belum ada, Docker membuatnya otomatis saat container dibuat. Supervisor tidak memberi label dan tidak menghapus volume kustom ini.
- `workspacePath` harus absolut, dinormalisasi, tidak boleh mengandung karakter kontrol atau `:`, dan tidak boleh menunjuk ke `/`. Path harus berupa direktori di host.
- Jika `TENANT_WORKSPACE_ROOT` di-set, `workspacePath` wajib berada di dalam direktori tersebut.
- Jika container yang sudah ada memiliki target `/workspace` yang berbeda, supervisor menghapus dan membuat ulang container sebelum menyalakannya. Ini mencegah container lama tetap ter-mount ke workspace tenant sebelumnya. Volume profile dan volume workspace tidak dihapus saat penggantian.
- Perubahan `tenantId` juga memicu pembuatan ulang container agar label tenant tidak basi.

### Contoh

Tanpa override, memakai volume default Bot:

```bash
curl -X POST http://localhost:4300/computers/bot-123/ensure \
  -H "Authorization: Bearer $SUPERVISOR_TOKEN"
```

Dengan volume khusus tenant:

```bash
curl -X POST http://localhost:4300/computers/bot-123/ensure \
  -H "Authorization: Bearer $SUPERVISOR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "tenantId": "firm-abc",
    "workspaceVolume": "tenant-firm-abc-workspace"
  }'
```

Dengan bind mount direktori host:

```bash
curl -X POST http://localhost:4300/computers/bot-123/ensure \
  -H "Authorization: Bearer $SUPERVISOR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "tenantId": "user-456",
    "workspacePath": "/tenants/users/user-456/workspace"
  }'
```

Body boleh kosong atau tidak dikirim sama sekali. Body yang bukan JSON valid, bukan object, atau berisi field dengan tipe yang salah ditolak dengan `400`.

Contoh respons:

```json
{
  "botId": "bot-123",
  "container": "openbot-computer-bot-123",
  "status": "running",
  "startedAt": "2026-10-23T10:00:00.000Z",
  "tenantId": "user-456",
  "url": "http://openbot-computer-bot-123:4100",
  "spiffeId": "spiffe://openbot/bot/bot-123"
}
```

`url` berbentuk nama container jika `COMPUTER_NETWORK` di-set, atau `http://127.0.0.1:<port>` jika supervisor berjalan di luar jaringan Docker.

---

## 3. Endpoint

| Method | Path | Fungsi |
| --- | --- | --- |
| `GET` | `/health` | Status supervisor dan konektivitas Docker. Tidak memerlukan token. |
| `POST` | `/computers/:botId/ensure` | Buat atau pakai ulang komputer, opsional dengan workspace tenant. |
| `POST` | `/computers/:botId/stop` | Hentikan komputer; profile dan workspace tetap ada. |
| `POST` | `/computers/:botId/reset` | Hapus container dan volume profile; workspace tidak dihapus. |
| `GET` | `/computers` | Daftar komputer milik deployment ini. |

Semua endpoint selain `/health` memerlukan header:

```text
Authorization: Bearer <SUPERVISOR_TOKEN>
```

Status error yang penting:

- `400`: Bot id, body, atau target workspace tidak valid.
- `401`: Token supervisor tidak cocok.
- `409`: Nama container dipegang resource yang bukan milik deployment ini.
- `503`: Docker tidak dapat dihubungi, atau komputer tidak siap menjawab.

---

## 4. Konfigurasi Environment

| Variabel | Default | Fungsi |
| --- | --- | --- |
| `PORT` | `4300` | Port listener supervisor. |
| `SUPERVISOR_TOKEN` | wajib | Secret yang harus dikirim pemanggil. Supervisor menolak start tanpa ini. |
| `COMPUTER_IMAGE` | `openbot-agent-computer:latest` | Image container worker. |
| `COMPUTER_NAMESPACE` | `openbot` | Namespace nama container, volume, dan label. |
| `COMPUTER_NETWORK` | tidak di-set | Network Docker yang diikuti container. Jika di-set, port tidak dipublikasikan. |
| `COMPUTER_RUNTIME` | tidak di-set | Runtime container, misalnya `runsc` untuk gVisor. |
| `COMPUTER_MEMORY_BYTES` | tidak di-set | Batas memori per komputer. |
| `SPIRE_AGENT_SOCKET_VOLUME` | tidak di-set | Volume socket SPIRE Agent, di-mount read-only. |
| `TENANT_WORKSPACE_ROOT` | tidak di-set | Direktori host yang menjadi allowlist untuk `workspacePath`. Sangat disarankan di produksi, misalnya `/tenants`. |

---

## 5. Catatan Keamanan

- **Bind mount adalah akses host.** `workspacePath` memasukkan direktori host ke dalam container. Salah memilih path dapat mengekspos data deployment lain atau file sistem. Set `TENANT_WORKSPACE_ROOT=/tenants` dan buat struktur direktori per tenant di bawahnya.
- **Jangan pernah mengarahkan `workspacePath` ke path sensitif** seperti `/`, `/var/run`, `/proc`, `/sys`, atau file socket Docker. Validasi saat ini menolak root dan karakter bind-mount berbahaya, tetapi allowlist direktori tetap merupakan kontrol utama.
- **Allowlist bersifat leksikal.** `TENANT_WORKSPACE_ROOT` memeriksa path setelah normalisasi, bukan symlink. Pastikan direktori tenant bukan symlink yang menunjuk ke luar root tersebut.
- **Path yang belum ada dapat dibuat oleh Docker** sebagai direktori milik root. Provision direktori tenant terlebih dahulu dengan permission yang benar.
- **`tenantId` adalah label, bukan kunci isolasi.** Isolasi data ditentukan oleh volume/path yang di-mount. Jangan memakai satu `botId` untuk beberapa tenant yang tidak saling percaya, karena volume `/profiles` bersifat per Bot dan tidak ikut berubah saat workspace diganti.
- **Volume kustom adalah milik pengelola tenant.** Supervisor tidak membuat label kepemilikan, tidak menghapus, dan tidak membersihkannya. Siklus hidupnya harus dikelola oleh lapisan tenant di atas supervisor.
- **Token supervisor bukan satu-satunya batas.** Bahkan dengan token yang benar, permintaan tetap hanya dapat menyentuh container yang namanya diturunkan dari Bot id tervalidasi dan workspace yang lolos validasi.
- **Container lama diganti, bukan di-remount.** Docker tidak bisa mengganti mount container yang sedang berjalan. Karena itu supervisor membandingkan mount `/workspace` saat `ensure` dan membuat ulang container jika targetnya berubah, sehingga workspace tenant sebelumnya tidak tertinggal di container yang sama.
