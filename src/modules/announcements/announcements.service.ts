import { NotificationType, TenantStatus } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { announcementEmail } from "../../lib/emailTemplates";
import { deliverEmail, SendResult } from "../notifications/notifications.service";

const MAX_RECIPIENTS = 500;

export interface AnnouncementEmailSummary {
  total: number;
  sent: number;
  failed: number;
  skipped: number; // tenants with no email address
  results: { tenantId: string; tenantName: string; status: SendResult["status"]; reason?: string }[];
}

// Emails one announcement to the tenants who are staying now (ACTIVE or on notice).
// If the announcement belongs to one property, only tenants staying in that property get it.
// Each tenant is emailed one at a time, so a problem with one address never stops the others.
export async function emailAnnouncement(organizationId: string, announcementId: string): Promise<AnnouncementEmailSummary> {
  const announcement = await prisma.announcement.findFirstOrThrow({
    where: { id: announcementId, organizationId },
    include: { organization: { select: { name: true, phone: true, email: true } } },
  });

  const tenants = await prisma.tenant.findMany({
    where: {
      organizationId,
      status: { in: [TenantStatus.ACTIVE, TenantStatus.NOTICE_PERIOD] },
      ...(announcement.propertyId
        ? { stays: { some: { checkOutDate: null, bed: { room: { propertyId: announcement.propertyId } } } } }
        : {}),
    },
    select: { id: true, name: true, email: true },
    orderBy: { name: "asc" },
    take: MAX_RECIPIENTS,
  });

  const results: AnnouncementEmailSummary["results"] = [];
  for (const tenant of tenants) {
    if (!tenant.email) {
      results.push({ tenantId: tenant.id, tenantName: tenant.name, status: "SKIPPED", reason: "Tenant has no email address" });
      continue;
    }
    const mail = announcementEmail({
      tenantName: tenant.name,
      pg: announcement.organization,
      title: announcement.title,
      body: announcement.body,
    });
    const result = await deliverEmail({
      organizationId,
      tenantId: tenant.id,
      type: NotificationType.ANNOUNCEMENT,
      to: tenant.email,
      ...mail,
    });
    results.push({ tenantId: tenant.id, tenantName: tenant.name, ...result });
  }

  await prisma.announcement.update({ where: { id: announcement.id }, data: { emailedAt: new Date() } });

  const count = (status: SendResult["status"]) => results.filter((r) => r.status === status).length;
  return { total: results.length, sent: count("SENT"), failed: count("FAILED"), skipped: count("SKIPPED"), results };
}
