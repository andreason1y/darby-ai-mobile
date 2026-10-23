#!/usr/bin/env python3
"""Draft Indonesian litigation documents from a case JSON.

Modes:
  somasi          Surat Somasi I or II
  gugatan         Surat Gugatan Wanprestasi or Perbuatan Melawan Hukum
  matriks-bukti   Evidence matrix P-1..P-N

The documents are formal court-ready drafts. Facts, names, numbers and
authorities come only from the JSON the caller supplies.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from datetime import date, datetime
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence

from docx import Document
from docx.enum.table import WD_ALIGN_VERTICAL, WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Cm, Pt, RGBColor
from pydantic import BaseModel, ConfigDict, ValidationError


NAVY = RGBColor(0x1F, 0x38, 0x64)
DARK = RGBColor(0x22, 0x22, 0x22)
GREY = RGBColor(0x59, 0x59, 0x59)
NAVY_FILL = "1F3864"
WHITE_FILL = "FFFFFF"
LIGHT_FILL = "EDF2FA"

MONTHS = [
    "Januari", "Februari", "Maret", "April", "Mei", "Juni",
    "Juli", "Agustus", "September", "Oktober", "November", "Desember",
]


class LitigationError(Exception):
    """A case-data or document problem that should be shown to the caller."""


class Flexible(BaseModel):
    model_config = ConfigDict(extra="allow", populate_by_name=True)


class LegalAuthority(Flexible):
    citation: str = ""
    description: str = ""


class Party(Flexible):
    name: str = ""
    kind: str = "Perorangan"
    identification: str = ""
    address: str = ""
    email: str = ""
    phone: str = ""
    representative: str = ""
    position: str = ""


class Court(Flexible):
    name: str = ""
    address: str = ""


class Agreement(Flexible):
    title: str = ""
    number: str = ""
    date: str = ""
    parties: str = ""


class Losses(Flexible):
    material: float | None = None
    immaterial: str = ""
    description: str = ""


class Demand(Flexible):
    text: str = ""
    deadline: str = ""


class SomasiData(Flexible):
    level: int = 1
    previous_number: str = ""
    previous_date: str = ""
    previous_delivered: str = ""
    demands: list[Demand] = []
    deadline: str = ""
    consequences: str = ""
    attachments: list[str] = []


class PositaItem(Flexible):
    heading: str = ""
    paragraphs: list[str] = []


class Petitum(Flexible):
    primer: list[str] = []
    subsider: list[str] = []
    ex_aequo: str = ""


class GugatanData(Flexible):
    posita: list[PositaItem] = []
    petitum: Petitum = Petitum()


class Evidence(Flexible):
    number: str = ""
    description: str = ""
    relevance: str = ""
    notes: str = ""
    kind: str = ""


class Signature(Flexible):
    place: str = ""
    date: str = ""
    name: str = ""
    position: str = "Advokat"
    firm: str = ""
    bar_number: str = ""
    phone: str = ""
    email: str = ""


class DocumentMeta(Flexible):
    type: str = ""
    number: str = ""
    date: str = ""
    place: str = ""
    subject: str = ""
    basis: str = "wanprestasi"
    confidentiality: str = "RAHASIA"


class CaseData(Flexible):
    document: DocumentMeta = DocumentMeta()
    court: Court = Court()
    plaintiff: Party = Party()
    defendant: Party = Party()
    agreement: Agreement = Agreement()
    chronology: list[str] = []
    default_description: str = ""
    losses: Losses = Losses()
    legal_basis: list[LegalAuthority] = []
    somasi: SomasiData = SomasiData()
    gugatan: GugatanData = GugatanData()
    evidence: list[Evidence] = []
    signature: Signature = Signature()
    case_number: str = ""
    value: float | None = None
    attachments: list[str] = []
    notes: list[str] = []


# ---------------------------------------------------------------------------
# Input normalisation
# ---------------------------------------------------------------------------


def _text(value: Any, default: str = "") -> str:
    if value is None:
        return default
    text = str(value).strip()
    return text or default


def _pick(data: Mapping[str, Any], *names: str, default: Any = None) -> Any:
    for name in names:
        if name in data and data[name] not in (None, ""):
            return data[name]
    return default


def _dict(value: Any) -> dict[str, Any]:
    return dict(value) if isinstance(value, Mapping) else {}


def _list(value: Any) -> list[Any]:
    if value is None:
        return []
    if isinstance(value, list):
        return value
    if isinstance(value, tuple):
        return list(value)
    return [value]


def _strings(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, Mapping):
        return [
            f"{_text(key)}: {_text(item)}" if _text(item) else _text(key)
            for key, item in value.items()
        ]
    return [_text(item) for item in _list(value) if _text(item)]


def _number(value: Any) -> float | None:
    if value is None or value == "":
        return None
    if isinstance(value, (int, float)):
        return float(value)
    text = re.sub(r"(?i)\b(?:rp|idr)\b", "", str(value))
    text = text.replace(" ", "")
    if "," in text and "." in text:
        if text.rfind(",") > text.rfind("."):
            text = text.replace(".", "").replace(",", ".")
        else:
            text = text.replace(",", "")
    elif "," in text:
        text = text.replace(",", ".")
    elif text.count(".") > 1:
        text = text.replace(".", "")
    try:
        return float(text)
    except ValueError:
        match = re.search(r"\d+(?:[.,]\d+)?", text)
        if not match:
            return None
        try:
            return float(match.group(0).replace(",", "."))
        except ValueError:
            return None


def _normalise_party(item: dict[str, Any], kind: str = "Perorangan") -> dict[str, Any]:
    return {
        "name": _text(_pick(item, "name", "nama", "nama_lengkap", "company_name")),
        "kind": _text(_pick(item, "kind", "type", "jenis", "tipe", "status_hukum"), kind),
        "identification": _text(
            _pick(item, "identification", "nik", "npwp", "ktp", "passport", "nomor_identitas", "id_number")
        ),
        "address": _text(_pick(item, "address", "alamat", "domisili", "kedudukan")),
        "email": _text(_pick(item, "email", "surel")),
        "phone": _text(_pick(item, "phone", "telepon", "telp", "hp", "contact")),
        "representative": _text(_pick(item, "representative", "perwakilan", "kuasa", "direktur", "pic")),
        "position": _text(_pick(item, "position", "jabatan")),
    }


def _normalise_authority(item: Any) -> dict[str, Any]:
    if not isinstance(item, Mapping):
        return {"citation": _text(item), "description": ""}
    return {
        "citation": _text(_pick(item, "citation", "sitasi", "pasal", "authority", "regulation", "law")),
        "description": _text(_pick(item, "description", "uraian", "summary", "ringkasan", "relevance", "keterangan")),
    }


def _normalise_demand(item: Any, fallback_deadline: str = "") -> dict[str, Any]:
    if not isinstance(item, Mapping):
        return {"text": _text(item), "deadline": fallback_deadline}
    return {
        "text": _text(_pick(item, "text", "uraian", "demand", "tuntutan", "description", "request")),
        "deadline": _text(_pick(item, "deadline", "tenggat", "due", "within"), fallback_deadline),
    }


def _normalise_posita(item: Any, index: int) -> dict[str, Any]:
    if not isinstance(item, Mapping):
        return {"heading": "", "paragraphs": [_text(item)]}
    heading = _text(_pick(item, "heading", "judul", "title"))
    paragraphs = _strings(_pick(item, "paragraphs", "paragraf", "body", "uraian", "text", "content"))
    if not paragraphs:
        value = _pick(item, "description", "fakta")
        if value:
            paragraphs = [_text(value)]
    return {"heading": heading, "paragraphs": paragraphs}


def _normalise_petitum(value: Any) -> dict[str, Any]:
    if isinstance(value, Mapping):
        primer = _strings(_pick(value, "primer", "primary", "pokok", "items"))
        subsider = _strings(_pick(value, "subsider", "subsidiary", "subsidiair", "alternatif"))
        ex_aequo = _text(_pick(value, "ex_aequo", "ex_aequo_et_bono", "equity"))
        return {"primer": primer, "subsider": subsider, "ex_aequo": ex_aequo}
    return {"primer": _strings(value), "subsider": [], "ex_aequo": ""}


def _normalise_evidence(item: Any, index: int, default_prefix: str = "P") -> dict[str, Any]:
    if not isinstance(item, Mapping):
        return {
            "number": f"{default_prefix}-{index}",
            "description": _text(item),
            "relevance": "",
            "notes": "",
            "kind": "Surat",
        }
    number = _text(_pick(item, "number", "nomor", "no", "code", "kode"))
    if not number:
        number = f"{default_prefix}-{index}"
    return {
        "number": number,
        "description": _text(_pick(item, "description", "uraian", "bukti", "title", "nama")),
        "relevance": _text(_pick(item, "relevance", "relevansi", "posita", "purpose")),
        "notes": _text(_pick(item, "notes", "keterangan", "catatan", "note")),
        "kind": _text(_pick(item, "kind", "jenis", "type"), "Surat"),
    }


def _normalise_case(raw: Any) -> CaseData:
    if not isinstance(raw, Mapping):
        raise LitigationError("Case JSON must be an object.")
    data = dict(raw)
    for wrapper in ("case", "perkara", "data", "payload"):
        inner = data.get(wrapper)
        if isinstance(inner, Mapping) and len(data) <= 3:
            data = {**inner, **{k: v for k, v in data.items() if k != wrapper}}
    document = _dict(_pick(data, "document", "dokumen", "letter", "surat"))
    meta = {
        "type": _text(_pick(document, "type", "jenis", "mode"), _text(_pick(data, "type", "jenis"))),
        "number": _text(_pick(document, "number", "nomor", "no")),
        "date": _text(_pick(document, "date", "tanggal"), _text(_pick(data, "date", "tanggal"))),
        "place": _text(_pick(document, "place", "tempat", "kota"), _text(_pick(data, "place", "tempat", "kota"))),
        "subject": _text(_pick(document, "subject", "perihal", "hal")),
        "basis": _text(_pick(document, "basis", "dasar", "legal_basis_type"), _text(_pick(data, "basis", "dasar"))),
        "confidentiality": _text(_pick(document, "confidentiality", "kerahasiaan"), "RAHASIA"),
    }

    court = _dict(_pick(data, "court", "pengadilan", "forum"))
    if not court:
        court_value = _pick(data, "court_name", "nama_pengadilan")
        if court_value:
            court = {"name": court_value}

    parties = _dict(_pick(data, "parties", "para_pihak", "pihak"))
    plaintiff_raw = _pick(data, "plaintiff", "penggugat", "pemohon", "client", "klien", "sender", "pengirim")
    defendant_raw = _pick(data, "defendant", "tergugat", "termohon", "recipient", "penerima", "lawan")
    if not plaintiff_raw and parties:
        plaintiff_raw = _pick(parties, "plaintiff", "penggugat", "pemohon", "pertama", "first")
    if not defendant_raw and parties:
        defendant_raw = _pick(parties, "defendant", "tergugat", "termohon", "kedua", "second")
    if isinstance(_pick(data, "parties", "para_pihak", "pihak"), list):
        party_list = _list(_pick(data, "parties", "para_pihak", "pihak"))
        if len(party_list) >= 1 and not plaintiff_raw:
            plaintiff_raw = party_list[0]
        if len(party_list) >= 2 and not defendant_raw:
            defendant_raw = party_list[1]

    plaintiff = _normalise_party(_dict(plaintiff_raw), "Perorangan")
    defendant = _normalise_party(_dict(defendant_raw), "Perorangan")

    case_part = _dict(_pick(data, "case", "perkara", "case_data", "facts", "fakta"))
    agreement = _dict(_pick(data, "agreement", "perjanjian", "kontrak", "contract"))
    if not agreement:
        agreement = _dict(_pick(case_part, "agreement", "perjanjian", "kontrak"))
    chronology = _strings(_pick(case_part, "chronology", "kronologi", "facts", "fakta", "timeline"))
    if not chronology:
        chronology = _strings(_pick(data, "chronology", "kronologi", "facts", "fakta", "timeline"))
    if not chronology:
        chronology = _strings(_pick(data, "posita", "dalil"))

    gib = _dict(_pick(data, "gugatan", "pleading", "claim"))
    somasi_part = _dict(_pick(data, "somasi", "warning", "teguran"))
    posita_raw = _pick(gib, "posita", "dalil", "fundamentum_petendi")
    if not posita_raw:
        posita_raw = _pick(data, "posita", "dalil", "fundamentum_petendi")
    posita = [_normalise_posita(item, index) for index, item in enumerate(_list(posita_raw), start=1)]
    petitum = _normalise_petitum(_pick(gib, "petitum", "tuntutan", "prayer", default=_pick(data, "petitum", "tuntutan")))

    losses = _dict(_pick(data, "losses", "kerugian", "damages", "claim_value"))
    if not losses:
        losses = _dict(_pick(case_part, "losses", "kerugian", "damages"))
    value = _number(_pick(data, "value", "nilai", "nilai_gugatan", "claim_value"))
    loss_material = _number(_pick(losses, "material", "materiil", "material_loss", "amount"))
    if value is None:
        value = loss_material

    authority_raw = _pick(data, "legal_basis", "dasar_hukum", "authorities", "laws")
    if not authority_raw:
        authority_raw = _pick(case_part, "legal_basis", "dasar_hukum")
    authorities = [_normalise_authority(item) for item in _list(authority_raw)]

    somasi_data = _dict(_pick(data, "somasi", "warning", "teguran"))
    somasi = {
        "level": int(
            _number(_pick(somasi_data, "level", "tingkat", "somasi_level"))
            or _number(_pick(data, "level", "tingkat"))
            or 1
        ),
        "previous_number": _text(_pick(somasi_part, "previous_number", "nomor_sebelumnya", "prior_number")),
        "previous_date": _text(_pick(somasi_part, "previous_date", "tanggal_sebelumnya", "prior_date")),
        "previous_delivered": _text(_pick(somasi_part, "previous_delivered", "tanggal_diterima", "delivered_on")),
        "demands": [
            _normalise_demand(item, _text(_pick(somasi_part, "deadline", "tenggat")))
            for item in _list(_pick(somasi_part, "demands", "tuntutan", "permintaan", "requests", default=_pick(data, "demands", "tuntutan", "permintaan")))
        ],
        "deadline": _text(_pick(somasi_part, "deadline", "tenggat", "due", default=_pick(data, "deadline", "tenggat"))),
        "consequences": _text(_pick(somasi_part, "consequences", "konsekuensi", "akibat", "warning")),
        "attachments": _strings(_pick(somasi_part, "attachments", "lampiran", default=_pick(data, "attachments", "lampiran"))),
    }

    evidence_prefix = "T" if _text(_pick(data, "evidence_prefix", "prefix_bukti")).upper() == "T" else "P"
    evidence_raw = _pick(data, "evidence", "bukti", "matriks_bukti", "alat_bukti", "exhibits")
    evidence = [_normalise_evidence(item, index, evidence_prefix) for index, item in enumerate(_list(evidence_raw), start=1)]

    signature = _dict(_pick(data, "signature", "tanda_tangan", "signer", "penandatangan"))
    if not signature:
        signature = _dict(_pick(data, "attorney", "kuasa_hukum", "advokat", "counsel"))
    signature = {
        "place": _text(_pick(signature, "place", "tempat", "kota"), meta["place"] or "Jakarta"),
        "date": _text(_pick(signature, "date", "tanggal"), meta["date"]),
        "name": _text(_pick(signature, "name", "nama", "attorney_name")),
        "position": _text(_pick(signature, "position", "jabatan", "title"), "Advokat"),
        "firm": _text(_pick(signature, "firm", "kantor", "law_firm", "firm_name")),
        "bar_number": _text(_pick(signature, "bar_number", "nomor_peradi", "peradi", "license")),
        "phone": _text(_pick(signature, "phone", "telepon", "telp", "hp")),
        "email": _text(_pick(signature, "email", "surel")),
    }

    case = CaseData(
        document=DocumentMeta.model_validate(meta),
        court=Court.model_validate(
            {
                "name": _text(_pick(court, "name", "nama", "court_name")),
                "address": _text(_pick(court, "address", "alamat", "kedudukan")),
            }
        ),
        plaintiff=Party.model_validate(plaintiff),
        defendant=Party.model_validate(defendant),
        agreement=Agreement.model_validate(
            {
                "title": _text(_pick(agreement, "title", "judul", "name", "nama")),
                "number": _text(_pick(agreement, "number", "nomor", "no")),
                "date": _text(_pick(agreement, "date", "tanggal")),
                "parties": _text(_pick(agreement, "parties", "para_pihak", "pihak")),
            }
        ),
        chronology=[item for item in chronology if item],
        default_description=_text(_pick(case_part, "default", "wanprestasi", "breach", "description")),
        losses=Losses.model_validate(
            {
                "material": loss_material,
                "immaterial": _text(_pick(losses, "immaterial", "immateriil", "immaterial_loss")),
                "description": _text(_pick(losses, "description", "uraian", "details")),
            }
        ),
        legal_basis=[LegalAuthority.model_validate(item) for item in authorities],
        somasi=SomasiData.model_validate(somasi),
        gugatan=GugatanData.model_validate({"posita": posita, "petitum": petitum}),
        evidence=[Evidence.model_validate(item) for item in evidence],
        signature=Signature.model_validate(signature),
        case_number=_text(_pick(data, "case_number", "nomor_perkara", "register")),
        value=value,
        attachments=_strings(_pick(data, "attachments", "lampiran", "enclosures")),
        notes=_strings(_pick(data, "notes", "catatan", "keterangan")),
    )
    if not case.document.place:
        case.document.place = case.signature.place
    return case


# ---------------------------------------------------------------------------
# Formatting helpers
# ---------------------------------------------------------------------------


def _indonesian_date(value: str | None = None) -> str:
    if value:
        text = value.strip()
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", text):
            return text
        try:
            parsed = datetime.strptime(text, "%Y-%m-%d").date()
          # noqa: E999 - kept explicit for readability
        except ValueError:
            return text
    else:
        parsed = date.today()
    return f"{parsed.day} {MONTHS[parsed.month - 1]} {parsed.year}"


def _date_line(place: str, value: str) -> str:
    if value and "," in value:
        return value
    return f"{place}, {_indonesian_date(value)}" if place else _indonesian_date(value)


def _rupiah(value: float | None) -> str:
    if value is None:
        return ""
    return "Rp " + f"{value:,.0f}".replace(",", ".")


def _set_run_font(run: Any, *, size: float = 12, bold: bool = False, italic: bool = False, color: RGBColor | None = None) -> None:
    run.font.name = "Times New Roman"
    run.font.size = Pt(size)
    run.bold = bold
    run.italic = italic
    if color is not None:
        run.font.color.rgb = color
    run._element.rPr.rFonts.set(qn("w:eastAsia"), "Times New Roman")


def _setup_document() -> Document:
    doc = Document()
    section = doc.sections[0]
    section.page_width = Cm(21.0)
    section.page_height = Cm(29.7)
    section.top_margin = Cm(2.5)
    section.bottom_margin = Cm(2.5)
    section.left_margin = Cm(3.0)
    section.right_margin = Cm(2.5)
    section.header_distance = Cm(1.25)
    section.footer_distance = Cm(1.25)

    normal = doc.styles["Normal"]
    normal.font.name = "Times New Roman"
    normal.font.size = Pt(12)
    normal.font.color.rgb = DARK
    normal.paragraph_format.space_after = Pt(6)
    normal.paragraph_format.line_spacing = 1.15
    normal.element.rPr.rFonts.set(qn("w:eastAsia"), "Times New Roman")

    footer = section.footer
    paragraph = footer.paragraphs[0]
    paragraph.alignment = WD_ALIGN_PARAGRAPH.CENTER
    run = paragraph.add_run("RAHASIA — DRAFT KERJA | Halaman ")
    _set_run_font(run, size=8, color=GREY)
    _add_field(paragraph, "PAGE")
    run = paragraph.add_run(" dari ")
    _set_run_font(run, size=8, color=GREY)
    _add_field(paragraph, "NUMPAGES")
    return doc


def _add_field(paragraph: Any, field: str) -> None:
    run = paragraph.add_run()
    begin = OxmlElement("w:fldChar")
    begin.set(qn("w:fldCharType"), "begin")
    instruction = OxmlElement("w:instrText")
    instruction.set(qn("xml:space"), "preserve")
    instruction.text = field
    separate = OxmlElement("w:fldChar")
    separate.set(qn("w:fldCharType"), "separate")
    text = OxmlElement("w:t")
    text.text = "1"
    end = OxmlElement("w:fldChar")
    end.set(qn("w:fldCharType"), "end")
    run._r.append(begin)
    run._r.append(instruction)
    run._r.append(separate)
    run._r.append(text)
    run._r.append(end)
    _set_run_font(run, size=8, color=GREY)


def _paragraph(
    doc: Document,
    text: str = "",
    *,
    bold: bool = False,
    italic: bool = False,
    size: float = 12,
    align: int = WD_ALIGN_PARAGRAPH.JUSTIFY,
    space_after: float = 6,
    space_before: float = 0,
    indent: float | None = None,
    first_line: float | None = None,
    color: RGBColor | None = None,
    keep_with_next: bool = False,
) -> Any:
    paragraph = doc.add_paragraph()
    paragraph.alignment = align
    paragraph.paragraph_format.space_after = Pt(space_after)
    paragraph.paragraph_format.space_before = Pt(space_before)
    paragraph.paragraph_format.line_spacing = 1.15
    if indent is not None:
        paragraph.paragraph_format.left_indent = Cm(indent)
    if first_line is not None:
        paragraph.paragraph_format.first_line_indent = Cm(first_line)
    if keep_with_next:
        paragraph.paragraph_format.keep_with_next = True
    if text:
        run = paragraph.add_run(text)
        _set_run_font(run, size=size, bold=bold, italic=italic, color=color)
    return paragraph


def _heading(doc: Document, text: str, *, size: float = 12, space_before: float = 12) -> Any:
    return _paragraph(
        doc,
        text.upper(),
        bold=True,
        size=size,
        align=WD_ALIGN_PARAGRAPH.LEFT,
        space_before=space_before,
        space_after=6,
        color=NAVY,
        keep_with_next=True,
    )


def _number_paragraph(doc: Document, number: str, text: str, *, indent: float = 0.9) -> Any:
    paragraph = doc.add_paragraph()
    paragraph.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY
    paragraph.paragraph_format.space_after = Pt(5)
    paragraph.paragraph_format.line_spacing = 1.15
    paragraph.paragraph_format.left_indent = Cm(indent)
    paragraph.paragraph_format.first_line_indent = Cm(-indent)
    run = paragraph.add_run(f"{number}. ")
    _set_run_font(run, bold=False)
    run = paragraph.add_run(text)
    _set_run_font(run)
    return paragraph


def _letterhead(doc: Document, firm: str, address: str = "", contact: str = "") -> None:
    if firm:
        _paragraph(doc, firm.upper(), bold=True, size=15, align=WD_ALIGN_PARAGRAPH.CENTER, space_after=2, color=NAVY)
    else:
        _paragraph(doc, "[NAMA KANTOR ADVOKAT / TIM HUKUM]", bold=True, size=15, align=WD_ALIGN_PARAGRAPH.CENTER, space_after=2, color=NAVY)
    if address:
        _paragraph(doc, address, size=9, align=WD_ALIGN_PARAGRAPH.CENTER, space_after=1, color=GREY)
    if contact:
        _paragraph(doc, contact, size=9, align=WD_ALIGN_PARAGRAPH.CENTER, space_after=4, color=GREY)
    line = _paragraph(doc, "", space_after=10)
    p_pr = line._p.get_or_add_pPr()
    borders = OxmlElement("w:pBdr")
    bottom = OxmlElement("w:bottom")
    bottom.set(qn("w:val"), "single")
    bottom.set(qn("w:sz"), "12")
    bottom.set(qn("w:space"), "1")
    bottom.set(qn("w:color"), "1F3864")
    borders.append(bottom)
    p_pr.append(borders)


def _cell_shading(cell: Any, fill: str) -> None:
    tc_pr = cell._tc.get_or_add_tcPr()
    shd = OxmlElement("w:shd")
    shd.set(qn("w:val"), "clear")
    shd.set(qn("w:color"), "auto")
    shd.set(qn("w:fill"), fill)
    tc_pr.append(shd)


def _cell_margins(cell: Any, top: int = 80, bottom: int = 80, left: int = 100, right: int = 100) -> None:
    tc_pr = cell._tc.get_or_add_tcPr()
    tc_mar = OxmlElement("w:tcMar")
    for name, value in (("top", top), ("bottom", bottom), ("left", left), ("right", right)):
        node = OxmlElement(f"w:{name}")
        node.set(qn("w:w"), str(value))
        node.set(qn("w:type"), "dxa")
        tc_mar.append(node)
    tc_pr.append(tc_mar)


def _repeat_table_header(row: Any) -> None:
    tr_pr = row._tr.get_or_add_trPr()
    header = OxmlElement("w:tblHeader")
    header.set(qn("w:val"), "true")
    tr_pr.append(header)


def _set_cell_text(cell: Any, text: str, *, bold: bool = False, size: float = 9.5, color: RGBColor | None = None, align: int = WD_ALIGN_PARAGRAPH.LEFT) -> None:
    cell.text = ""
    paragraph = cell.paragraphs[0]
    paragraph.alignment = align
    paragraph.paragraph_format.space_after = Pt(0)
    paragraph.paragraph_format.line_spacing = 1.0
    run = paragraph.add_run(text)
    _set_run_font(run, size=size, bold=bold, color=color)
    cell.vertical_alignment = WD_ALIGN_VERTICAL.CENTER


def _table(doc: Document, headers: Sequence[str], rows: Sequence[Sequence[str]], widths: Sequence[float]) -> Any:
    table = doc.add_table(rows=1, cols=len(headers))
    table.style = "Table Grid"
    table.alignment = WD_TABLE_ALIGNMENT.CENTER
    table.autofit = False
    header = table.rows[0]
    _repeat_table_header(header)
    for index, label in enumerate(headers):
        cell = header.cells[index]
        _set_cell_text(cell, label, bold=True, size=9, color=RGBColor(0xFF, 0xFF, 0xFF), align=WD_ALIGN_PARAGRAPH.CENTER)
        _cell_shading(cell, NAVY_FILL)
        _cell_margins(cell)
        cell.width = Cm(widths[index])
    for row_values in rows:
        row = table.add_row()
        for index, value in enumerate(row_values):
            cell = row.cells[index]
            _set_cell_text(cell, _text(value), size=9)
            _cell_margins(cell)
            cell.width = Cm(widths[index])
    # Fixed layout keeps the widths honoured by Word.
    tbl_pr = table._tbl.tblPr
    layout = OxmlElement("w:tblLayout")
    layout.set(qn("w:type"), "fixed")
    tbl_pr.append(layout)
    return table


def _signature_block(doc: Document, signature: Signature, *, capacity: str) -> None:
    _paragraph(doc, _date_line(signature.place, signature.date), align=WD_ALIGN_PARAGRAPH.RIGHT, space_before=16, space_after=4)
    _paragraph(doc, capacity, align=WD_ALIGN_PARAGRAPH.RIGHT, bold=True, space_after=0)
    _paragraph(doc, "", align=WD_ALIGN_PARAGRAPH.RIGHT, space_after=0)
    _paragraph(doc, "", align=WD_ALIGN_PARAGRAPH.RIGHT, space_after=0)
    _paragraph(doc, "", align=WD_ALIGN_PARAGRAPH.RIGHT, space_after=0)
    _paragraph(doc, signature.name or "________________________", align=WD_ALIGN_PARAGRAPH.RIGHT, bold=True, space_after=0)
    if signature.bar_number:
        _paragraph(doc, f"Nomor Peradi: {signature.bar_number}", align=WD_ALIGN_PARAGRAPH.RIGHT, size=10, space_after=0)
    if signature.firm:
        _paragraph(doc, signature.firm, align=WD_ALIGN_PARAGRAPH.RIGHT, size=10, space_after=0)
    if signature.phone or signature.email:
        contact = " | ".join(value for value in (signature.phone, signature.email) if value)
        _paragraph(doc, contact, align=WD_ALIGN_PARAGRAPH.RIGHT, size=9, color=GREY, space_after=0)


def _identity_block(doc: Document, label: str, party: Party) -> None:
    _paragraph(doc, label, bold=True, space_before=8, space_after=3)
    rows = [("Nama", party.name)]
    if party.identification:
        rows.append(("NIK / NPWP / Identitas", party.identification))
    if party.kind:
        rows.append(("Bentuk Hukum", party.kind))
    if party.address:
        rows.append(("Alamat", party.address))
    if party.representative:
        rows.append(("Perwakilan", party.representative + (f" ({party.position})" if party.position else "")))
    if party.email:
        rows.append(("Email", party.email))
    if party.phone:
        rows.append(("Telepon", party.phone))
    for field, value in rows:
        paragraph = doc.add_paragraph()
        paragraph.paragraph_format.space_after = Pt(2)
        paragraph.paragraph_format.left_indent = Cm(0.6)
        paragraph.paragraph_format.line_spacing = 1.1
        run = paragraph.add_run(f"{field}\t: ")
        _set_run_font(run, size=11)
        run = paragraph.add_run(value or "")
        _set_run_font(run, size=11)


def _default_authorities(basis: str) -> list[LegalAuthority]:
    if basis == "pmh":
        return [
            LegalAuthority(citation="Pasal 1365 KUHPerdata", description="Perbuatan melawan hukum yang menimbulkan kerugian mewajibkan pelaku mengganti kerugian."),
            LegalAuthority(citation="Pasal 1366 KUHPerdata", description="Tanggung jawab atas kerugian yang timbul karena kelalaian atau kurang hati-hati."),
        ]
    return [
        LegalAuthority(citation="Pasal 1243 KUHPerdata", description="Debitur wajib memberikan ganti rugi atas wanprestasi, kecuali membuktikan tidak terpenuhinya perikatan bukan karena kesalahannya."),
        LegalAuthority(citation="Pasal 1244 KUHPerdata", description="Ganti rugi meliputi biaya, kerugian, dan bunga yang layak."),
    ]


def _basis_label(basis: str) -> str:
    return "Perbuatan Melawan Hukum" if basis == "pmh" else "Wanprestasi"


def _opening_sender(case: CaseData) -> str:
    signature = case.signature
    plaintiff = case.plaintiff.name or "[NAMA PEMBERI KUASA]"
    if signature.name and signature.name != case.plaintiff.name:
        capacity = f"{signature.position or 'Advokat'}"
        if signature.firm:
            capacity += f" pada {signature.firm}"
        return (
            f"Kami, {signature.name}, {capacity}, bertindak selaku kuasa hukum dari "
            f"{plaintiff}, dengan ini menyampaikan somasi kepada:"
        )
    return f"Kami, {plaintiff}, dengan ini menyampaikan somasi kepada:"


def _agreement_sentence(case: CaseData) -> str:
    agreement = case.agreement
    parts = []
    if agreement.title:
        parts.append(agreement.title)
    if agreement.number:
        parts.append(f"Nomor {agreement.number}")
    if agreement.date:
        parts.append(f"tanggal {_indonesian_date(agreement.date)}")
    if not parts:
        return ""
    return "Bahwa Para Pihak telah terikat dalam " + ", ".join(parts) + "."


# ---------------------------------------------------------------------------
# Somasi
# ---------------------------------------------------------------------------


def _build_somasi(case: CaseData, level: int) -> tuple[Document, dict[str, Any]]:
    if not case.defendant.name:
        raise LitigationError("Nama penerima somasi (defendant/tergugat) wajib diisi.")
    if not case.somasi.demands:
        raise LitigationError("Somasi memerlukan minimal satu tuntutan (somasi.demands).")
    case.document.basis = (case.document.basis or "wanprestasi").lower()
    if case.document.basis in {"perbuatan melawan hukum", "perbuatan-melawan-hukum", "1365", "pmh"}:
        case.document.basis = "pmh"
    else:
        case.document.basis = "wanprestasi"
    level = 2 if level == 2 else 1
    case.somasi.level = level

    doc = _setup_document()
    warnings: list[str] = []
    if not case.signature.name:
        warnings.append("Nama penandatangan belum diisi; dokumen memakai garis tanda tangan kosong.")
    if not case.legal_basis:
        case.legal_basis = _default_authorities(case.document.basis)
        warnings.append("Dasar hukum standar digunakan; verifikasi sebelum dikirim.")
    if not case.document.number:
        warnings.append("Nomor surat belum diisi.")

    _letterhead(doc, case.signature.firm, case.signature.email or "", case.signature.phone or "")
    _paragraph(doc, _date_line(case.document.place, case.document.date), align=WD_ALIGN_PARAGRAPH.RIGHT, space_after=8)
    if case.document.number:
        _paragraph(doc, f"Nomor: {case.document.number}", space_after=10)
    _paragraph(doc, "Kepada Yth.", space_after=0)
    _paragraph(doc, case.defendant.name, bold=True, space_after=0)
    if case.defendant.address:
        _paragraph(doc, case.defendant.address, space_after=8)
    subject = case.document.subject or f"Somasi {'II (Kedua) — Peringatan Terakhir' if level == 2 else 'I (Pertama)'} — {_basis_label(case.document.basis)}"
    _paragraph(doc, f"Perihal: {subject}", bold=True, space_after=12)

    _paragraph(doc, "Dengan hormat,", space_after=8)
    _paragraph(doc, _opening_sender(case), space_after=8)

    intro = _agreement_sentence(case)
    if intro:
        _paragraph(doc, intro)

    if level == 2:
        previous = "Somasi I"
        if case.somasi.previous_number:
            previous += f" Nomor {case.somasi.previous_number}"
        if case.somasi.previous_date:
            previous += f" tanggal {_indonesian_date(case.somasi.previous_date)}"
        if case.somasi.previous_delivered:
            previous += f" yang telah diterima pada {_indonesian_date(case.somasi.previous_delivered)}"
        _paragraph(
            doc,
            f"Bahwa sampai dengan surat ini disampaikan, {previous} belum dipenuhi dan/atau tidak ditanggapi secara substantif oleh {case.defendant.name}. Dengan demikian, surat ini merupakan peringatan terakhir sebelum kami menempuh upaya hukum.",
        )

    if case.chronology:
        _paragraph(doc, "Adapun kronologi peristiwa hukumnya adalah sebagai berikut:", space_after=5)
        for index, item in enumerate(case.chronology, start=1):
            _number_paragraph(doc, str(index), item)

    if case.default_description:
        _paragraph(doc, case.default_description)
    elif case.document.basis == "pmh":
        _paragraph(
            doc,
            f"Bahwa perbuatan {case.defendant.name} tersebut memenuhi unsur perbuatan melawan hukum sebagaimana dimaksud dalam Pasal 1365 KUHPerdata dan menimbulkan kerugian bagi {case.plaintiff.name or 'pemberi kuasa'}.",
        )
    else:
        _paragraph(
            doc,
            f"Bahwa {case.defendant.name} telah tidak memenuhi kewajiban sebagaimana disepakati dan karenanya berada dalam keadaan wanprestasi sebagaimana dimaksud dalam Pasal 1243 KUHPerdata.",
        )

    if case.legal_basis:
        _paragraph(doc, "Dasar hukum yang relevan:", bold=True, space_before=6, space_after=3)
        for index, authority in enumerate(case.legal_basis, start=1):
            text = authority.citation
            if authority.description:
                text += f" — {authority.description}"
            _number_paragraph(doc, str(index), text)

    if case.losses.material is not None or case.losses.immaterial or case.losses.description:
        _paragraph(doc, "Bahwa akibat perbuatan tersebut, pemberi kuasa mengalami kerugian:", space_before=6, space_after=3)
        if case.losses.material is not None:
            _number_paragraph(doc, "a", f"Kerugian materiel sebesar {_rupiah(case.losses.material)}.")
        if case.losses.immaterial:
            _number_paragraph(doc, "b", f"Kerugian imateriel berupa {case.losses.immaterial}.")
        if case.losses.description:
            _paragraph(doc, case.losses.description)

    _paragraph(doc, "Berdasarkan hal-hal tersebut di atas, kami menuntut:", bold=True, space_before=8, space_after=4)
    for index, demand in enumerate(case.somasi.demands, start=1):
        deadline = f" dalam tenggat {demand.deadline}" if demand.deadline else ""
        _number_paragraph(doc, str(index), f"{demand.text}{deadline}.")
    if case.somasi.deadline:
        _paragraph(
            doc,
            f"Seluruh tuntutan tersebut wajib dipenuhi paling lambat {case.somasi.deadline} sejak surat ini diterima.",
            bold=True,
        )

    if case.somasi.consequences:
        _paragraph(doc, case.somasi.consequences)
    elif level == 2:
        _paragraph(
            doc,
            "Apabila dalam tenggat tersebut tuntutan tidak dipenuhi, kami akan menempuh upaya hukum perdata dan/atau pidana sesuai ketentuan yang berlaku, termasuk mengajukan gugatan ke pengadilan yang berwenang, tanpa pemberitahuan lebih lanjut.",
        )
    else:
        _paragraph(
            doc,
            "Apabila dalam tenggat tersebut tuntutan tidak dipenuhi, kami akan menerbitkan Somasi II sebagai peringatan terakhir dan selanjutnya menempuh upaya hukum yang tersedia.",
        )

    _paragraph(doc, "Demikian surat somasi ini kami sampaikan. Atas perhatian dan kerja sama yang baik, kami ucapkan terima kasih.", space_before=6)
    _signature_block(doc, case.signature, capacity="Kuasa Hukum" if case.signature.name and case.signature.name != case.plaintiff.name else "Pemberi Kuasa")

    attachments = case.somasi.attachments or case.attachments
    if attachments:
        _paragraph(doc, "Lampiran:", bold=True, space_before=12, space_after=3)
        for index, item in enumerate(attachments, start=1):
            _number_paragraph(doc, str(index), item)

    doc.core_properties.title = f"Somasi {level} — {_basis_label(case.document.basis)}"
    doc.core_properties.subject = case.document.subject
    doc.core_properties.author = case.signature.firm or case.signature.name
    return doc, {
        "mode": "somasi",
        "level": level,
        "basis": case.document.basis,
        "documentType": f"Somasi {level}",
        "warnings": warnings,
    }


# ---------------------------------------------------------------------------
# Gugatan
# ---------------------------------------------------------------------------


def _build_gugatan(case: CaseData) -> tuple[Document, dict[str, Any]]:
    if not case.plaintiff.name:
        raise LitigationError("Nama penggugat (plaintiff/penggugat) wajib diisi.")
    if not case.defendant.name:
        raise LitigationError("Nama tergugat (defendant/tergugat) wajib diisi.")
    if not case.gugatan.posita:
        raise LitigationError("Gugatan memerlukan minimal satu butir posita.")
    if not case.gugatan.petitum.primer:
        raise LitigationError("Gugatan memerlukan minimal satu petitum primer.")
    if not case.court.name:
        raise LitigationError("Nama pengadilan (court.name) wajib diisi.")

    case.document.basis = (case.document.basis or "wanprestasi").lower()
    if case.document.basis in {"perbuatan melawan hukum", "perbuatan-melawan-hukum", "1365", "pmh"}:
        case.document.basis = "pmh"
    else:
        case.document.basis = "wanprestasi"

    doc = _setup_document()
    warnings: list[str] = []
    if not case.signature.name:
        warnings.append("Nama kuasa hukum/penggugat belum diisi; dokumen memakai garis tanda tangan kosong.")
    if not case.legal_basis:
        case.legal_basis = _default_authorities(case.document.basis)
        warnings.append("Dasar hukum standar digunakan; verifikasi sebelum didaftarkan.")
    if not case.document.number:
        warnings.append("Nomor surat gugatan belum diisi.")

    _letterhead(doc, case.signature.firm, case.signature.email or "", case.signature.phone or "")
    _paragraph(doc, _date_line(case.document.place, case.document.date), align=WD_ALIGN_PARAGRAPH.RIGHT, space_after=8)
    if case.document.number:
        _paragraph(doc, f"Nomor: {case.document.number}", space_after=8)
    _paragraph(doc, "Kepada Yth.", space_after=0)
    _paragraph(doc, f"Ketua {case.court.name}", bold=True, space_after=0)
    if case.court.address:
        _paragraph(doc, case.court.address, space_after=8)
    _paragraph(doc, f"Perihal: GUGATAN {_basis_label(case.document.basis).upper()}", bold=True, space_after=12)
    _paragraph(doc, "Dengan hormat,", space_after=8)

    sender = case.signature.name or case.plaintiff.name
    capacity = case.signature.position or "Advokat"
    if case.signature.firm:
        capacity += f" pada {case.signature.firm}"
    _paragraph(
        doc,
        f"Yang bertanda tangan di bawah ini, {sender}, {capacity}, bertindak selaku kuasa hukum Penggugat, dengan ini mengajukan gugatan kepada:",
    )

    _identity_block(doc, "PENGGUGAT:", case.plaintiff)
    _paragraph(doc, f"Selanjutnya disebut sebagai \u201cPENGGUGAT\u201d.", italic=True, space_after=2)
    _identity_block(doc, "TERGUGAT:", case.defendant)
    _paragraph(doc, f"Selanjutnya disebut sebagai \u201cTERGUGAT\u201d.", italic=True, space_after=8)

    _paragraph(doc, "Adapun yang menjadi dasar dan alasan gugatan ini adalah sebagai berikut:", space_after=6)
    _heading(doc, "A. POSITA (FUNDAMENTUM PETENDI)")
    if case.agreement.title or case.agreement.number or case.agreement.date:
        intro = _agreement_sentence(case)
        if intro:
            _paragraph(doc, intro)
    for index, item in enumerate(case.gugatan.posita, start=1):
        if item.heading:
            _paragraph(doc, f"{index}. {item.heading}", bold=True, space_before=4, space_after=2)
            offset = 1
        else:
            offset = 0
        for paragraph_index, text in enumerate(item.paragraphs, start=1):
            if offset:
                _number_paragraph(doc, f"{index}.{paragraph_index}", text)
            else:
                _number_paragraph(doc, str(index) if paragraph_index == 1 else f"{index}.{paragraph_index}", text)
        # A posita item with a heading but no paragraph still needs a visible entry.
        if item.heading and not item.paragraphs:
            _paragraph(doc, "")

    if case.legal_basis:
        _heading(doc, "B. DASAR HUKUM")
        for index, authority in enumerate(case.legal_basis, start=1):
            text = authority.citation
            if authority.description:
                text += f" — {authority.description}"
            _number_paragraph(doc, str(index), text)

    _heading(doc, "C. PETITUM")
    court_name = case.court.name or "Pengadilan Negeri yang berwenang"
    _paragraph(
        doc,
        f"Berdasarkan seluruh uraian posita di atas, Penggugat memohon kepada Yang Terhormat Ketua {court_name} agar berkenan memeriksa dan memutus perkara ini dengan amar sebagai berikut:",
    )
    _paragraph(doc, "PRIMER:", bold=True, space_before=4, space_after=3)
    for index, item in enumerate(case.gugatan.petitum.primer, start=1):
        _number_paragraph(doc, str(index), item)
    if case.gugatan.petitum.subsider:
        _paragraph(doc, "SUBSIDER:", bold=True, space_before=8, space_after=3)
        for index, item in enumerate(case.gugatan.petitum.subsider, start=1):
            _number_paragraph(doc, str(index), item)
    if case.gugatan.petitum.ex_aequo:
        _paragraph(doc, case.gugatan.petitum.ex_aequo, italic=True, space_before=6)
    else:
        _paragraph(
            doc,
            "Atau apabila Majelis Hakim berpendapat lain, mohon putusan yang seadil-adilnya (ex aequo et bono).",
            italic=True,
            space_before=6,
        )

    if case.value is not None:
        _paragraph(doc, f"Nilai gugatan: {_rupiah(case.value)}.", space_before=6)
    _paragraph(doc, "Demikian gugatan ini diajukan. Atas perhatian dan pemeriksaan Yang Terhormat Ketua Pengadilan, kami ucapkan terima kasih.", space_before=6)
    _signature_block(doc, case.signature, capacity="Kuasa Hukum Penggugat" if case.signature.name else "Penggugat")

    attachments = case.attachments or [
        "Surat Kuasa Khusus;",
        "Bukti P-1 dan seterusnya (sesuai matriks pembuktian);",
        "Salinan dokumen pendukung.",
    ]
    _paragraph(doc, "Lampiran:", bold=True, space_before=12, space_after=3)
    for index, item in enumerate(attachments, start=1):
        _number_paragraph(doc, str(index), item)

    doc.core_properties.title = f"Gugatan {_basis_label(case.document.basis)}"
    doc.core_properties.subject = case.document.subject
    doc.core_properties.author = case.signature.firm or case.signature.name
    return doc, {
        "mode": "gugatan",
        "basis": case.document.basis,
        "documentType": f"Gugatan {_basis_label(case.document.basis)}",
        "positaItems": len(case.gugatan.posita),
        "petitumItems": len(case.gugatan.petitum.primer) + len(case.gugatan.petitum.subsider),
        "warnings": warnings,
    }


# ---------------------------------------------------------------------------
# Evidence matrix
# ---------------------------------------------------------------------------


def _build_evidence_matrix(case: CaseData) -> tuple[Document, dict[str, Any]]:
    if not case.evidence:
        raise LitigationError("Matriks bukti memerlukan minimal satu alat bukti (evidence).")

    doc = _setup_document()
    warnings: list[str] = []
    if not case.plaintiff.name or not case.defendant.name:
        warnings.append("Identitas para pihak belum lengkap.")
    if not case.court.name:
        warnings.append("Nama pengadilan belum diisi.")

    _letterhead(doc, case.signature.firm, case.signature.email or "", case.signature.phone or "")
    _paragraph(doc, "MATRIKS PEMBUKTIAN", bold=True, size=14, align=WD_ALIGN_PARAGRAPH.CENTER, color=NAVY, space_after=2)
    if case.court.name:
        _paragraph(doc, case.court.name, bold=True, align=WD_ALIGN_PARAGRAPH.CENTER, space_after=2)
    if case.case_number:
        _paragraph(doc, f"Nomor Perkara: {case.case_number}", align=WD_ALIGN_PARAGRAPH.CENTER, space_after=8)
    else:
        _paragraph(doc, "", space_after=6)

    if case.plaintiff.name or case.defendant.name:
        _paragraph(
            doc,
            f"Penggugat: {case.plaintiff.name or '[tidak diisi]'}  |  Tergugat: {case.defendant.name or '[tidak diisi]'}",
            align=WD_ALIGN_PARAGRAPH.CENTER,
            size=10,
            space_after=10,
        )

    rows = []
    for index, item in enumerate(case.evidence, start=1):
        description = item.description
        if item.kind and not description.lower().startswith(item.kind.lower()):
            description = f"{item.kind}: {description}" if description else item.kind
        rows.append([item.number or f"P-{index}", description, item.relevance, item.notes])
    _table(
        doc,
        ["Nomor Bukti", "Uraian Bukti", "Relevansi Posita", "Keterangan"],
        rows,
        [3.0, 7.0, 4.5, 3.0],
    )

    _paragraph(
        doc,
        "Catatan: kolom Relevansi Posita merujuk pada butir posita gugatan yang dibuktikan. Alat bukti yang belum lengkap ditandai pada kolom Keterangan.",
        size=9,
        italic=True,
        color=GREY,
        space_before=8,
    )
    _signature_block(doc, case.signature, capacity="Kuasa Hukum Penggugat" if case.signature.name else "Penggugat")

    doc.core_properties.title = "Matriks Pembuktian"
    doc.core_properties.subject = case.document.subject
    doc.core_properties.author = case.signature.firm or case.signature.name
    return doc, {
        "mode": "matriks-bukti",
        "documentType": "Matriks Pembuktian",
        "evidenceCount": len(case.evidence),
        "warnings": warnings,
    }


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def _load_case(input_value: str) -> CaseData:
    if input_value == "-":
        try:
            raw = json.load(sys.stdin)
        except json.JSONDecodeError as exc:
            raise LitigationError(f"Input JSON dari stdin tidak valid: {exc}") from exc
    else:
        path = Path(input_value)
        if not path.exists():
            raise LitigationError(f"Input tidak ditemukan: {path}")
        if path.suffix.lower() != ".json":
            raise LitigationError("Input kasus harus berupa file .json.")
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise LitigationError(f"Input JSON tidak dapat dibaca: {exc}") from exc
    return _normalise_case(raw)


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Draft Indonesian somasi, gugatan, or evidence matrix DOCX files."
    )
    subparsers = parser.add_subparsers(dest="mode", required=True)

    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--input", required=True, help="Case JSON path, or - for stdin.")
    common.add_argument("--output", required=True, help="Output .docx path.")
    common.add_argument("--json", action="store_true", help="Print a machine-readable report.")

    somasi_parser = subparsers.add_parser(
        "somasi", parents=[common], help="Draft Surat Somasi I or II."
    )
    somasi_parser.add_argument("--level", type=int, choices=(1, 2), default=None, help="Somasi level.")
    somasi_parser.add_argument(
        "--basis", choices=("wanprestasi", "pmh"), default=None, help="Legal basis."
    )

    gugatan_parser = subparsers.add_parser(
        "gugatan", parents=[common], help="Draft a wanprestasi or PMH gugatan."
    )
    gugatan_parser.add_argument(
        "--basis", choices=("wanprestasi", "pmh"), default=None, help="Legal basis."
    )

    subparsers.add_parser(
        "matriks-bukti",
        aliases=["matriks_bukti"],
        parents=[common],
        help="Draft an evidence matrix.",
    )

    args = parser.parse_args(argv)
    try:
        case = _load_case(args.input)
        if args.mode == "somasi":
            level = args.level if args.level is not None else case.somasi.level
            if args.basis:
                case.document.basis = args.basis
            doc, report = _build_somasi(case, level=level)
        elif args.mode == "gugatan":
            if args.basis:
                case.document.basis = args.basis
            doc, report = _build_gugatan(case)
        else:
            doc, report = _build_evidence_matrix(case)

        output = Path(args.output)
        if output.suffix.lower() != ".docx":
            raise LitigationError("Output harus berupa file .docx.")
        output.parent.mkdir(parents=True, exist_ok=True)
        doc.save(output)
        report.update({"ok": True, "output": str(output)})
    except (LitigationError, ValidationError) as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 1
    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 1

    if args.json:
        print(json.dumps(report, ensure_ascii=False))
    else:
        print(f"{report.get('documentType', args.mode)} written to {report['output']}")
        for warning in report.get("warnings", []):
            print(f"Warning: {warning}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
