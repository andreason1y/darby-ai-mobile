# 04 — Spesifikasi Teknis `agent-computer` & Toolchain Legal

Dokumen ini mendefinisikan kustomisasi container worker (`agent-computer`), integrasi tool legal, dan adaptasi supervisor menjadi pool manager.

---

## 1. Modifikasi Dockerfile `agent-computer`

Container bawaan OpenBot berbasis Ubuntu 24.04 + Bun + Playwright Chromium. Untuk kebutuhan Legal Agent, container ini diperkaya dengan toolchain pemrosesan dokumen:

```dockerfile
# Tambahan layer sistem untuk dokumen legal & headless office
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    python3-venv \
    libreoffice-writer-nogpu \
    libreoffice-calc-nogpu \
    tesseract-ocr \
    tesseract-ocr-ind \
    poppler-utils \
    pandoc \
 && rm -rf /var/lib/apt/lists/*

# Environment Python khusus legal tools
RUN python3 -m venv /opt/legal-tools-env \
 && /opt/legal-tools-env/bin/pip install --no-cache-dir \
    python-docx \
    pymupdf \
    openpyxl \
    httpx \
    pydantic
```

---

## 2. Inventory Tools Khusus Legal

Tools ini dieksekusi di dalam container via shell atau RPC internal:

1. **`contract_redline.py`:**
   - Membaca file DOCX draf kontrak.
   - Menjalankan analisis per klausul menggunakan diff engine.
   - Menyisipkan revisi teks ke dalam format XML Word dengan tanda `w:ins` (penambahan) dan `w:del` (penghapusan) sehingga terbaca sebagai **Track Changes resmi Microsoft Word**.
   - Menambahkan *Word Comments* (`w:comment`) berisi alasan hukum / mitigasi risiko.
2. **`pdf_ocr_extractor.py`:**
   - Ekstraksi teks dari scan PDF buram (akta notaris lama, surat perjanjian tulisan tangan/materai) menggunakan PyMuPDF + Tesseract OCR Bahasa Indonesia.
3. **`legal_db_client.py`:**
   - Client HTTP/gRPC yang terhubung langsung ke Centralized Legal DB API.
   - Mengambil kutipan pasal dan ringkasan pertimbangan hakim tanpa perlu browsing web publik.
4. **`playwright_legal_roaming.ts`:**
   - Menggunakan Playwright Chromium bawaan untuk verifikasi live portal publik (jika diizinkan oleh Action Policy).

---

## 3. Adaptasi `supervisor` Menjadi Shared Pool Manager

Arsitektur bawaan OpenBot (`supervisor/src/docker.ts`) membuat 1 container per bot secara statis. Modifikasi yang dilakukan:

1. **Container Worker Pool:**
   - Menjaga N container (misal: 2-3 container hangat) siap pakai.
   - Menggunakan queue berbasis Redis atau PostgreSQL untuk antrean task.
2. **Dynamic Workspace Mounting:**
   - Saat task dijalankan, supervisor memasang bind mount direktori tenant:
     `-v /tenants/{tenant_id}/matters/{matter_id}:/workspace`
   - Token otentikasi sementara digenerate per sesi eksekusi.
3. **Automatic Cleanup & Recycling:**
   - Setelah eksekusi task selesai atau timeout (maks 10 menit), proses worker di-reset dan file cache non-persistent dihapus agar tidak terjadi kebocoran memori antar-tenant.
