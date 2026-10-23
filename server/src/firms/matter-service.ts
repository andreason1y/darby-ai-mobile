import { createHash } from "node:crypto";
import type { FirmType, LegalRole } from "../db/schema/firms";

export type { FirmType, LegalRole };

export type OrganizationTerminology = {
  orgLabel: string;
  projectLabel: string;
  clientLabel: string;
  playbookLabel: string;
  reviewFlowDescription: string;
};

export function getTerminology(type: FirmType): OrganizationTerminology {
  switch (type) {
    case "in_house":
      return {
        orgLabel: "Divisi Legal",
        projectLabel: "Proyek / Tiket Review",
        clientLabel: "Departemen Pemohon (Internal)",
        playbookLabel: "SOP & Standar Perusahaan",
        reviewFlowDescription: "Staff Legal analisa draf -> Head of Legal / Manager approve",
      };
    case "lbh":
      return {
        orgLabel: "LBH / Posbakum",
        projectLabel: "Perkara / Kasus Advokasi",
        clientLabel: "Penerima Bantuan Hukum",
        playbookLabel: "Panduan Litigasi & Advokasi",
        reviewFlowDescription: "Pengacara Publik susun berkas -> Direktur / Kepala Divisi approve",
      };
    case "solo":
      return {
        orgLabel: "Praktik Mandiri",
        projectLabel: "Berkas Perkara",
        clientLabel: "Klien",
        playbookLabel: "Standar Mandiri",
        reviewFlowDescription: "Advokat mandiri verifikasi langsung",
      };
    case "law_firm":
    default:
      return {
        orgLabel: "Kantor Hukum",
        projectLabel: "Perkara / Kasus",
        clientLabel: "Klien",
        playbookLabel: "Firm Playbook",
        reviewFlowDescription: "Associate analisa draf -> Partner approve",
      };
  }
}

export function getRoleDisplay(role: LegalRole, type: FirmType): string {
  if (type === "in_house") {
    switch (role) {
      case "managing_partner":
        return "Head of Legal / General Counsel";
      case "partner":
        return "Legal Manager / Lead Counsel";
      case "senior_associate":
        return "Senior Legal Specialist";
      case "associate":
        return "Staff Legal / Legal Specialist";
      case "paralegal":
        return "Legal Admin / Assistant";
      case "of_counsel":
        return "External Legal Advisor";
    }
  }

  if (type === "lbh") {
    switch (role) {
      case "managing_partner":
        return "Direktur LBH";
      case "partner":
        return "Kepala Divisi Advokasi";
      case "senior_associate":
        return "Pengacara Publik Senior";
      case "associate":
        return "Pengacara Publik";
      case "paralegal":
        return "Paralegal Komunitas";
      case "of_counsel":
        return "Dewan Penasihat / Pembina";
    }
  }

  switch (role) {
    case "managing_partner":
      return "Managing Partner";
    case "partner":
      return "Partner";
    case "senior_associate":
      return "Senior Associate";
    case "associate":
      return "Associate";
    case "paralegal":
      return "Paralegal";
    case "of_counsel":
      return "Of Counsel";
  }
}

export type WorkspaceContext = {
  userId: string;
  firmId?: string;
  matterId?: string;
};

export type ResolvedWorkspace = {
  volumeName: string;
  hostPath: string;
  tenantId: string;
};

const VOLUME_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const MAX_VOLUME_NAME = 255;

function pathSegment(value: string, field: string): string {
  if (
    value.length === 0 ||
    value === "." ||
    value === ".." ||
    /[/\\\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error(`${field} must be a single path segment.`);
  }
  return value;
}

function volumeNameFor(...parts: string[]): string {
  const raw = `openbot-${parts.join("-")}`;
  if (raw.length <= MAX_VOLUME_NAME && VOLUME_NAME.test(raw)) return raw;

  const digest = createHash("sha256").update(raw).digest("hex").slice(0, 16);
  const readable = raw
    .replace(/[^A-Za-z0-9_.-]/g, "-")
    .replace(/^[^A-Za-z0-9]+/, "")
    .slice(0, MAX_VOLUME_NAME - digest.length - 1);
  return `${readable || "openbot"}-${digest}`;
}

export function resolveWorkspaceForContext(
  params: WorkspaceContext,
): ResolvedWorkspace {
  const userId = pathSegment(params.userId, "userId");

  if (params.matterId !== undefined && params.firmId === undefined) {
    throw new Error("matterId requires firmId.");
  }

  if (params.firmId !== undefined) {
    const firmId = pathSegment(params.firmId, "firmId");
    const tenantId = firmId;

    if (params.matterId !== undefined) {
      const matterId = pathSegment(params.matterId, "matterId");
      return {
        volumeName: volumeNameFor("firm", firmId, "matter", matterId),
        hostPath: `/tenants/firms/${firmId}/matters/${matterId}`,
        tenantId,
      };
    }

    return {
      volumeName: volumeNameFor("firm", firmId, "shared"),
      hostPath: `/tenants/firms/${firmId}/shared`,
      tenantId,
    };
  }

  return {
    volumeName: volumeNameFor("user", userId),
    hostPath: `/tenants/users/${userId}/workspace`,
    tenantId: userId,
  };
}

const PARTNER_OR_ABOVE: readonly LegalRole[] = [
  "managing_partner",
  "partner",
];

const COURT_PLEADING_APPROVERS: readonly LegalRole[] = [
  "managing_partner",
  "partner",
  "senior_associate",
  "of_counsel",
];

export function isPartnerOrAbove(role: LegalRole): boolean {
  return PARTNER_OR_ABOVE.includes(role);
}

export function canApproveCourtPleadings(role: LegalRole): boolean {
  return COURT_PLEADING_APPROVERS.includes(role);
}

export function canManageFirmPlaybook(role: LegalRole): boolean {
  return isPartnerOrAbove(role);
}
