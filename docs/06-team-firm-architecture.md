# 06: Arsitektur Tim, Firma Hukum, dan Isolasi Matter

Dokumen ini menjelaskan model multi-tenant untuk tim legal: firma hukum, in-house legal, Lembaga Bantuan Hukum (LBH), dan solo practitioner. Fokusnya ada pada tiga hal yang saling mengunci: struktur peran, batas kewenangan, dan isolasi direktori matter saat container worker dijalankan.

---

## 1. Prinsip Dasar

1. **Komputasi boleh dibagi, data tidak.** Container worker berasal dari shared pool, tetapi setiap eksekusi hanya boleh melihat satu workspace tenant.
2. **Peran firma dan akses matter adalah dua lapis berbeda.** `firm_memberships.role` menjawab "siapa orang ini di firma". `matter_memberships.access_level` menjawab "sejauh apa ia boleh menyentuh perkara ini".
3. **Akses dokumen tidak otomatis dari jabatan.** Menjadi partner tidak otomatis membuka seluruh matter. Isi matter hanya terbuka lewat keanggotaan matter yang eksplisit, kecuali alur administratif memang menetapkan akses tersebut.
4. **Path workspace tidak pernah berasal dari client.** Client hanya mengirim `matterId` atau konteks firma. Server yang menghitung path final, lalu supervisor memvalidasinya lagi sebelum mount.
5. **Gagal tertutup.** Membership yang tidak aktif, matter yang sudah ditutup, atau pengguna yang tidak terdaftar pada matter harus ditolak sebelum container dibuat.

---

## 2. Entitas dan Relasi

| Tabel | Isi | Kunci utama |
|---|---|---|
| `firms` | Identitas tenant: nama, slug, tipe firma, domain, pengaturan | `id` |
| `firm_memberships` | Siapa yang menjadi anggota firma dan dengan peran apa | `(firm_id, user_id)` |
| `matters` | Perkara atau pekerjaan legal, termasuk kanal, tipe kasus, lead partner, path workspace | `id` |
| `matter_memberships` | Siapa yang boleh mengakses satu matter dan pada level apa | `(matter_id, user_id)` |
| `firm_playbooks` | Playbook standar firma dalam bentuk JSON | `id` |

Relasi utamanya:

```
firms 1 --- n firm_memberships n --- 1 users
firms 1 --- n matters 1 --- n matter_memberships n --- 1 users
firms 1 --- n firm_playbooks
matters n --- 1 channels
matters n --- 1 users (lead_partner_id, opsional)
```

Nilai enum yang dipakai:

- `firm_type`: `law_firm`, `in_house`, `lbh`, `solo`
- `legal_role`: `managing_partner`, `partner`, `senior_associate`, `associate`, `paralegal`, `of_counsel`
- `membership_status`: `active`, `invited`, `suspended`
- `matter_case_type`: `litigation`, `corporate_transaction`, `contract_review`, `general_advisory`
- `matter_status`: `open`, `active`, `closed`
- `matter_access_level`: `lead`, `editor`, `viewer`

---

## 3. Struktur per Tipe Tenant

### 3.1 Firma Hukum (`law_firm`)

Firma hukum memiliki banyak lawyer dan satu atau lebih partner. Ciri utamanya:

- Matter dimiliki firma, bukan individu. Seorang associate bisa keluar, tetapi matter tetap milik firma.
- Playbook firma menjadi standar bersama untuk review kontrak dan drafting.
- Dokumen klien dipisahkan per matter. Direktori shared firma hanya memuat template, playbook, dan knowledge non-klien.
- Lead partner pada `matters.lead_partner_id` adalah penanggung jawab profesional, bukan pemilik data.
- Paralegal membantu administrasi dan bundling dokumen, tanpa kewenangan menyetujui produk hukum.

### 3.2 LBH (`lbh`)

LBH memakai struktur yang sama dengan firma, tetapi tekanannya berbeda:

- Rasio supervising lawyer terhadap paralegal atau volunteer lebih tinggi, sehingga persetujuan berlapis lebih penting.
- Data penerima bantuan bersifat sensitif. Akses matter harus lebih ketat, dan daftar anggota matter dijaga seminimal mungkin.
- Playbook LBH mencakup format surat kuasa, somasi, permohonan bantuan hukum, dan dokumen pro bono.
- Tidak ada asumsi billing komersial. Pengaturan biaya disimpan di `firms.settings` jika diperlukan.

### 3.3 In-House Legal (`in_house`)

In-house adalah satu departemen legal di dalam perusahaan:

- "Firma" di sini adalah organisasi internal. Matter dapat berupa kontrak, sengketa, kepatuhan, atau proyek korporasi.
- Label peran sebaiknya dipetakan ke istilah korporasi di antarmuka, misalnya `managing_partner` menjadi General Counsel dan `partner` menjadi Head of Legal. Nilai enum tetap sama agar logika otorisasi tidak bercabang.
- Playbook berisi kebijakan internal: posisi klausul yang dapat diterima, batas indemnity, dan matriks eskalasi.
- `domain` dapat dipakai untuk pemetaan SSO atau verifikasi domain email perusahaan.
- Kolaborasi lintas divisi diberikan lewat `matter_memberships`, bukan dengan membuka seluruh workspace departemen.
### 3.4 Solo Practitioner (`solo`)

Solo adalah tenant satu orang:

- Workspace berada di `/tenants/users/{userId}/workspace`, bukan di bawah direktori firma.
- Tidak ada `firm_memberships` yang diperlukan untuk operasional harian.
- Playbook pribadi dapat disimpan sebagai `firm_playbooks` milik firma bertipe `solo`, atau tetap berada di workspace pengguna. Untuk isolasi yang sederhana, jalur eksekusi solo tidak mengirim `firmId`.
- Jika solo bergabung ke firma, data pribadi tidak boleh ikut termigrasi otomatis. Pemindahan matter harus menjadi tindakan eksplisit dengan jejak audit.

### 3.5 Perbandingan Ringkas

| Aspek | Firma Hukum | LBH | In-House | Solo |
|---|---|---|---|---|
| Pemilik matter | Firma | Lembaga | Perusahaan | Pengguna |
| Workspace default | Shared firma dan vault matter | Shared LBH dan vault matter | Shared departemen dan vault matter | Workspace pengguna |
| Playbook | Standar firma | Standar bantuan hukum | Kebijakan korporasi | Pribadi |
| Anggota | Banyak peran | Supervisor dan volunteer | Counsel dan staf legal | Satu orang |
| Kanal matter | Satu kanal per matter | Satu kanal per perkara | Satu kanal per proyek | Opsional |

---

## 4. Matriks Kewenangan per Peran

Matriks ini adalah kebijakan produk. Implementasi teknisnya ada di `server/src/firms/matter-service.ts` dan pemeriksaan keanggotaan di lapisan API.

| Kewenangan | Managing Partner | Partner | Senior Associate | Associate | Paralegal | Of Counsel |
|---|---|---|---|---|---|---|
| Mengelola identitas dan pengaturan firma | Ya | Terbatas | Tidak | Tidak | Tidak | Tidak |
| Mengundang atau menonaktifkan anggota firma | Ya | Dapat diizinkan | Tidak | Tidak | Tidak | Tidak |
| Membuat matter baru | Ya | Ya | Dapat diizinkan | Tidak | Tidak | Tidak |
| Menjadi lead partner matter | Ya | Ya | Tidak | Tidak | Tidak | Tidak |
| Menetapkan anggota dan level akses matter | Ya | Ya, untuk matter yang dipimpin | Hanya jika lead | Tidak | Tidak | Tidak |
| Menyunting dokumen matter | Ya | Ya | Ya, jika diberi `editor` atau `lead` | Ya, jika diberi `editor` | Ya, jika diberi `editor` untuk administrasi | Ya, jika diberi `editor` |
| Membaca dokumen matter | Ya, jika anggota matter | Ya, jika anggota matter | Ya, jika anggota matter | Ya, jika anggota matter | Ya, jika anggota matter | Ya, jika anggota matter |
| Menyetujui berkas sidang | Ya | Ya | Ya | Tidak | Tidak | Ya |
| Mengelola playbook firma | Ya | Ya | Tidak | Tidak | Tidak | Tidak |
| Menutup matter | Ya | Ya | Tidak | Tidak | Tidak | Tidak |

Catatan penting:

- `isPartnerOrAbove(role)` mengembalikan `true` untuk `managing_partner` dan `partner`.
- `canApproveCourtPleadings(role)` mengembalikan `true` untuk `managing_partner`, `partner`, `senior_associate`, dan `of_counsel`. Associate dan paralegal tidak boleh menjadi approver terakhir.
- `canManageFirmPlaybook(role)` mengembalikan `true` untuk `managing_partner` dan `partner`.
- Kewenangan firma tidak menggantikan `matter_memberships`. Partner yang bukan anggota matter tetap tidak boleh membaca isi vault matter tersebut.
- `matter_access_level` menentukan tindakan di dalam matter:
  - `lead`: mengelola anggota matter, menjalankan task tulis, dan menutup pekerjaan.
  - `editor`: membaca dan menulis dokumen, tetapi tidak mengubah keanggotaan.
  - `viewer`: membaca dan merangkum, tanpa operasi tulis ke vault.

---

## 5. Isolasi Matter Vault

### 5.1 Pemetaan Path

Server menghitung workspace dari konteks, bukan dari input path mentah:

| Konteks | `hostPath` | `tenantId` | Contoh `volumeName` |
|---|---|---|---|
| Firma dan matter | `/tenants/firms/{firmId}/matters/{matterId}` | `firmId` | `openbot-firm-{firmId}-matter-{matterId}` |
| Firma tanpa matter | `/tenants/firms/{firmId}/shared` | `firmId` | `openbot-firm-{firmId}-shared` |
| Solo | `/tenants/users/{userId}/workspace` | `userId` | `openbot-user-{userId}` |

Fungsi `resolveWorkspaceForContext` menolak segmen path yang kosong, mengandung `/`, `\`, karakter kontrol, atau bernilai `.` dan `..`. `matterId` tanpa `firmId` juga ditolak. Dengan begitu, nilai dari database atau request tidak bisa dipakai untuk keluar dari direktori tenant.

`volumeName` dipakai ketika deployment memilih named volume. Jika nama mengandung karakter yang tidak valid untuk Docker, nama dibersihkan dan diberi hash agar tetap unik. Untuk bind mount, yang dipakai adalah `hostPath`.

### 5.2 Pembagian Isi Workspace

```
/tenants
  /firms/{firmId}
    /shared
      playbook/
      templates/
      knowledge/
    /matters/{matterId}
      documents/
      drafts/
      evidence/
      correspondence/
      .openbot/playbooks/   (salinan playbook untuk task berjalan)
  /users/{userId}
    /workspace
      documents/
      drafts/
      .openbot/
```

Aturan isinya:

- `/shared` tidak boleh memuat dokumen klien. Isinya hanya aset yang memang boleh dilihat seluruh anggota firma.
- Satu matter mendapat satu direktori. Dua matter tidak pernah berbagi direktori, walaupun kliennya sama.
- Playbook firma disalin ke `.openbot/playbooks/` di dalam vault matter sebelum task dimulai. Container tidak perlu melihat seluruh direktori shared firma.
- Salinan playbook bersifat turunan. Sumber kebenaran tetap `firm_playbooks.playbook_json`, sehingga perubahan playbook tidak mengubah hasil review lama secara diam-diam.

### 5.3 Alur Mounting ke Container Worker

```
Mobile/Web
   |
   v
API server
   |  1. autentikasi user
   |  2. cek firm_memberships active
   |  3. cek matter_memberships dan access_level
   |  4. resolveWorkspaceForContext()
   v
Supervisor POST /computers/:botId/ensure
   |  { tenantId, workspacePath } atau { tenantId, workspaceVolume }
   |  5. validasi path absolut dan confinement ke tenantWorkspaceRoot
   v
Docker
   |  6. bind mount hostPath ke /workspace
   v
agent-computer
      7. task berjalan dengan path confinement internal
      8. selesai, container di-reset
```

Langkahnya:

1. API memastikan pengguna adalah anggota firma dengan status `active`. Status `invited` dan `suspended` ditolak.
2. API memastikan pengguna terdaftar di `matter_memberships` untuk matter yang diminta. Level akses menentukan jenis task yang boleh dijalankan.
3. API memanggil `resolveWorkspaceForContext({ userId, firmId, matterId })`.
4. API mengirim `tenantId` dan salah satu dari `workspacePath` atau `workspaceVolume` ke supervisor. Keduanya tidak boleh dikirim bersamaan.
5. Supervisor menormalkan path, menolak path relatif, karakter kontrol, dan path di luar `tenantWorkspaceRoot`. Root produksi adalah `/tenants`.
6. Docker memasang direktori tersebut ke `/workspace` di dalam container. Container hanya melihat satu workspace.
7. Di dalam container, `workspace.resolvePath` menolak akses keluar dari `/workspace`. Ini lapisan ketiga setelah pemeriksaan API dan supervisor.
8. Setelah task selesai, container dihentikan atau di-reset. Cache sementara dan salinan playbook untuk task tersebut dibersihkan.

### 5.4 Batas Keamanan yang Harus Dipertahankan

- Jangan pernah me-mount `/tenants` atau `/tenants/firms/{firmId}` ke container. Yang di-mount hanya direktori shared atau satu matter.
- Jangan menerima `workspacePath` dari client. Nilai itu selalu dihitung server dari ID yang sudah diotorisasi.
- Jangan memakai `matters.workspace_path` sebagai dasar otorisasi. Kolom itu adalah referensi operasional yang dapat dihitung ulang; otorisasi tetap berasal dari membership.
- Jangan menjalankan dua tenant pada satu container yang sama. Container yang dipakai ulang harus di-reset dan dipastikan tidak menyisakan file.
- Untuk `viewer`, operasi tulis ditolak di lapisan tool dan approval. Bind mount saat ini bersifat baca-tulis, sehingga pembatasan viewer tidak boleh hanya mengandalkan mode mount.
- Audit setiap permintaan mount: siapa, firma mana, matter mana, level akses, dan container mana yang dipakai.
- Matter berstatus `closed` tidak boleh menerima task baru. Container yang masih berjalan harus dihentikan, dan workspace dipindahkan ke arsip sesuai kebijakan retensi.

### 5.5 Siklus Hidup Matter

1. **Pembuatan.** Matter dibuat dengan `firm_id`, `case_type`, dan `status = open`. Direktori matter dibuat dengan permission tenant sebelum task pertama.
2. **Aktivasi.** Saat pekerjaan dimulai, status berubah menjadi `active`, anggota matter ditetapkan, dan playbook default firma disalin ke `.openbot/playbooks/`.
3. **Eksekusi.** Setiap task mendapat container dari pool, mount ke satu vault matter, lalu container dikembalikan ke pool setelah dibersihkan.
4. **Penutupan.** Status menjadi `closed`. Tidak ada task baru, akses tulis dicabut, dan container yang terkait dihentikan.
5. **Retensi.** Vault matter dipertahankan atau dihapus sesuai kebijakan firma. `firm_playbooks` tidak ikut terhapus karena bukan bagian dari vault matter.

---

## 6. Titik Penegakan Aturan

| Lapisan | Yang ditegakkan |
|---|---|
| Database | Foreign key, primary key komposit, enum peran dan status |
| Service | Perhitungan path, validasi segmen, helper RBAC |
| API | Autentikasi, status membership, keanggotaan matter, level akses |
| Supervisor | Path absolut, confinement ke root tenant, larangan volume dan path bersamaan |
| Container | Path confinement internal ke `/workspace` |
| Audit | Jejak siapa membuka matter dan container mana yang dipakai |

Kegagalan pada salah satu lapisan harus menghasilkan penolakan, bukan fallback ke workspace lain. Jika firma tidak ditemukan atau pengguna bukan anggota, request berhenti sebelum supervisor dipanggil.

---

## 7. Berkas Implementasi

- `server/src/db/schema/firms.ts`: enum, tabel, foreign key, dan index.
- `server/drizzle/0061_legal_firms_and_matters.sql`: DDL PostgreSQL untuk lima tabel dan enam enum.
- `server/src/firms/matter-service.ts`: `resolveWorkspaceForContext`, `isPartnerOrAbove`, `canApproveCourtPleadings`, `canManageFirmPlaybook`.
- `supervisor/src/docker.ts`: `workspaceMountFor` dan validasi `tenantWorkspaceRoot`.
- `docs/04-agent-computer-spec.md`: spesifikasi container dan toolchain legal.
