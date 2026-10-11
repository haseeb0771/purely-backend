import PDFDocument from "pdfkit";
import type { OrderDoc } from "../models/Order";
import { LOGO_PNG_BASE64 } from "../assets/logo";

/** A4 portrait dimensions in PDF points. */
const PAGE_W = 595.28;
const PAGE_H = 841.89;
const MARGIN = 44;

const COLORS = {
  navy: "#0B2545",
  navyDeep: "#07182F",
  teal: "#2FB9BF",
  tealSoft: "#8FE3E6",
  ink: "#0F172A",
  muted: "#64748B",
  line: "#E2E8F0",
  rowAlt: "#F8FAFC",
  white: "#FFFFFF",
} as const;

/** Static company contact details shown in the invoice footer. */
export const COMPANY = {
  name: "Purely Custom Labels",
  tagline: "Pure mineral water & custom labeled packaging",
  phone: "+92 300 107 6608",
  email: "purelycustomlabels@gmail.com",
  website: "purely-custom-labels.vercel.app",
  social: "@purelycustomlabels",
} as const;

const TERMS = [
  "Payment is due upon receipt of this invoice unless agreed otherwise.",
  "Goods remain the property of Purely Custom Labels until fully paid.",
  "Report any damaged or incorrect items within 24 hours of delivery.",
  "Custom labeled bottles are made to order and are non-refundable.",
];

export interface InvoiceLineItem {
  description: string;
  price: number;
  qty: number;
  total: number;
}

export interface InvoiceData {
  orderId: string;
  date: Date;
  deliveryDate: Date | null;
  client: {
    businessName: string;
    ownerName: string;
    phone: string;
    whatsapp: string;
  };
  items: InvoiceLineItem[];
  subTotal: number;
  tax: number;
  total: number;
  amountPaid: number;
  balanceDue: number;
  paymentStatus: string;
}

function round2(n: number): number {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function money(n: number): string {
  return `Rs. ${round2(n).toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  })}`;
}

function formatDate(date: Date | null | undefined): string {
  if (!date) return "—";
  return new Date(date).toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

function decamelSize(size: string): string {
  return size;
}

/** Assemble the printable invoice model purely from the stored order document. */
export function buildInvoiceData(order: OrderDoc): InvoiceData {
  const items: InvoiceLineItem[] = [];
  const breakdown = order.priceBreakdown;

  if (breakdown) {
    for (const line of breakdown.bottleLines) {
      const petCount = Number(line.petCount) || 0;
      // Per-PET bill: one line per bottle size, sold per PET pack. Packaging
      // is already folded into the bottle base cost, so the pack is the unit.
      if (petCount > 0) {
        const price = round2(Number(line.sellPerPET) || 0);
        const total = round2(Number(line.sellAmount) || 0);
        if (price <= 0 && total <= 0) continue;
        items.push({
          description: `${decamelSize(line.size)} Mineral Water`,
          price,
          qty: petCount,
          total: total > 0 ? total : round2(price * petCount),
        });
        continue;
      }
      // Orders recorded per bottle (no pack info) fall back to per-bottle lines.
      const qty = Number(line.quantity) || 0;
      if (qty <= 0) continue;
      const price = round2(Number(line.sellPerUnit) || 0);
      const total = round2(Number(line.sellAmount) || 0);
      if (price <= 0 && total <= 0) continue;
      items.push({
        description: `${decamelSize(line.size)} Mineral Water`,
        price,
        qty,
        total: total > 0 ? total : round2(price * qty),
      });
    }
  }

  const sellingPrice = round2(order.sellingPrice ?? 0);
  const itemsTotal = round2(items.reduce((sum, i) => sum + i.total, 0));

  // Legacy / summary orders without a per-size breakdown fall back to a single
  // line so the invoice always reflects the agreed selling price.
  if (items.length === 0 || (sellingPrice > 0 && itemsTotal <= 0)) {
    const sizes = (order.bottleSelection?.sizeQuantities ?? [])
      .map((s) => `${decamelSize(s.size)} × ${s.quantity}`)
      .join(", ");
    items.length = 0;
    items.push({
      description: `Custom Labeled Mineral Water Order${sizes ? ` (${sizes})` : ""}`,
      price: sellingPrice,
      qty: 1,
      total: sellingPrice,
    });
  }

  const totalPaid = round2(order.totalPaid ?? 0);
  return {
    orderId: order.orderId,
    date: order.createdAt ?? new Date(),
    deliveryDate: order.deliveryDate ?? null,
    client: {
      businessName: order.clientDetails?.businessName ?? "",
      ownerName: order.clientDetails?.ownerName ?? "",
      phone: order.clientDetails?.ownerPhone ?? "",
      whatsapp: order.clientDetails?.ownerWhatsapp ?? "",
    },
    items,
    subTotal: sellingPrice,
    tax: 0,
    total: sellingPrice,
    amountPaid: totalPaid,
    balanceDue: round2(Math.max(0, sellingPrice - totalPaid)),
    paymentStatus: order.paymentStatus ?? "UNPAID",
  };
}

function drawHeader(doc: PDFKit.PDFDocument, data: InvoiceData): number {
  // Navy header band with a fluid wavy lower edge.
  doc.save();
  doc.moveTo(0, 0);
  doc.lineTo(PAGE_W, 0);
  doc.lineTo(PAGE_W, 92);
  doc.bezierCurveTo(PAGE_W * 0.66, 64, PAGE_W * 0.3, 150, 0, 118);
  doc.closePath();
  doc.fillColor(COLORS.navy).fill();
  doc.restore();

  // Aqua accent wave hugging the navy edge.
  doc.save();
  doc.moveTo(0, 118);
  doc.bezierCurveTo(PAGE_W * 0.3, 150, PAGE_W * 0.66, 64, PAGE_W, 92);
  doc.lineTo(PAGE_W, 104);
  doc.bezierCurveTo(PAGE_W * 0.66, 76, PAGE_W * 0.3, 162, 0, 130);
  doc.closePath();
  doc.fillColor(COLORS.teal).fill();
  doc.restore();

  // Logo slot (clean white chip so any logo reads on the navy band).
  const chipX = MARGIN;
  const chipY = 28;
  const chipW = 168;
  const chipH = 48;
  doc.save();
  doc.roundedRect(chipX, chipY, chipW, chipH, 10).fillColor(COLORS.white).fill();
  doc.restore();
  try {
    const logo = Buffer.from(LOGO_PNG_BASE64, "base64");
    doc.image(logo, chipX + 12, chipY + 9, { fit: [chipW - 24, chipH - 18] });
  } catch {
    doc.fillColor(COLORS.navy).font("Helvetica-Bold").fontSize(15);
    doc.text(COMPANY.name, chipX + 12, chipY + 16, { width: chipW - 24 });
  }

  // Brand name beside the logo chip.
  doc.fillColor(COLORS.white).font("Helvetica-Bold").fontSize(15);
  doc.text(COMPANY.name, chipX + chipW + 14, chipY + 8, { width: 220 });
  doc.font("Helvetica").fontSize(8.5).fillColor(COLORS.tealSoft);
  doc.text(COMPANY.tagline, chipX + chipW + 14, chipY + 27, { width: 240 });

  // Big INVOICE wordmark (top-right).
  doc.fillColor(COLORS.white).font("Helvetica-Bold").fontSize(34);
  doc.text("INVOICE", MARGIN, 30, {
    width: PAGE_W - 2 * MARGIN,
    align: "right",
  });
  doc.font("Helvetica").fontSize(9).fillColor(COLORS.tealSoft);
  doc.text(`#${data.orderId}`, MARGIN, 68, {
    width: PAGE_W - 2 * MARGIN,
    align: "right",
  });

  return 168;
}

function drawParties(
  doc: PDFKit.PDFDocument,
  data: InvoiceData,
  startY: number
): number {
  const top = startY;
  const rightX = PAGE_W / 2 + 20;

  // INVOICE TO (left).
  doc.fillColor(COLORS.teal).font("Helvetica-Bold").fontSize(9);
  doc.text("INVOICE TO:", MARGIN, top, { characterSpacing: 1 });
  doc.fillColor(COLORS.ink).font("Helvetica-Bold").fontSize(12.5);
  doc.text(data.client.businessName || "—", MARGIN, top + 15, {
    width: PAGE_W / 2 - MARGIN - 24,
  });
  doc.font("Helvetica").fontSize(9.5).fillColor(COLORS.muted);
  const clientLines: string[] = [];
  if (data.client.ownerName) clientLines.push(data.client.ownerName);
  if (data.client.phone) clientLines.push(`Phone: ${data.client.phone}`);
  if (data.client.whatsapp) clientLines.push(`WhatsApp: ${data.client.whatsapp}`);
  const clientTextY = doc.y + 4;
  doc.text(clientLines.join("\n"), MARGIN, clientTextY, {
    width: PAGE_W / 2 - MARGIN - 24,
    lineGap: 2,
  });

  // Meta table (right).
  const meta: [string, string][] = [
    ["Invoice #", data.orderId],
    ["Date", formatDate(data.date)],
    ["Delivery", formatDate(data.deliveryDate)],
    ["Status", data.paymentStatus],
  ];
  let metaY = top - 4;
  const labelW = 70;
  doc.fontSize(9.5);
  for (const [label, value] of meta) {
    doc.font("Helvetica").fillColor(COLORS.muted);
    doc.text(label, rightX, metaY, { width: labelW });
    doc.font("Helvetica-Bold").fillColor(COLORS.ink);
    doc.text(value, rightX + labelW, metaY, {
      width: PAGE_W - MARGIN - (rightX + labelW),
      align: "right",
    });
    metaY += 16;
  }

  return Math.max(clientTextY + clientLines.length * 13, metaY) + 22;
}

interface Column {
  label: string;
  x: number;
  width: number;
  align: "left" | "right";
}

function tableColumns(): Column[] {
  const tableW = PAGE_W - 2 * MARGIN;
  const no = 34;
  const price = 86;
  const qty = 56;
  const total = 104;
  const desc = tableW - no - price - qty - total;
  let x = MARGIN;
  const cols: Column[] = [
    { label: "No.", x, width: no, align: "left" },
  ];
  x += no;
  cols.push({ label: "Description", x, width: desc, align: "left" });
  x += desc;
  cols.push({ label: "Price", x, width: price, align: "right" });
  x += price;
  cols.push({ label: "Qty", x, width: qty, align: "right" });
  x += qty;
  cols.push({ label: "Total", x, width: total, align: "right" });
  return cols;
}

function drawTableHeader(doc: PDFKit.PDFDocument, y: number): number {
  const cols = tableColumns();
  const tableW = PAGE_W - 2 * MARGIN;
  const h = 28;
  doc.save();
  doc.rect(MARGIN, y, tableW, h).fillColor(COLORS.navy).fill();
  doc.restore();
  doc.font("Helvetica-Bold").fontSize(9.5).fillColor(COLORS.white);
  for (const col of cols) {
    doc.text(col.label, col.x + 8, y + 9, {
      width: col.width - 16,
      align: col.align,
    });
  }
  return y + h;
}

function drawItemRow(
  doc: PDFKit.PDFDocument,
  item: InvoiceLineItem,
  index: number,
  y: number
): number {
  const cols = tableColumns();
  const tableW = PAGE_W - 2 * MARGIN;
  const rowH = 30;

  if (index % 2 === 1) {
    doc.save();
    doc.rect(MARGIN, y, tableW, rowH).fillColor(COLORS.rowAlt).fill();
    doc.restore();
  }
  doc.save();
  doc.moveTo(MARGIN, y + rowH).lineTo(MARGIN + tableW, y + rowH);
  doc.lineWidth(0.5).strokeColor(COLORS.line).stroke();
  doc.restore();

  const cells: [Column, string][] = [
    [cols[0], String(index + 1)],
    [cols[1], item.description],
    [cols[2], money(item.price)],
    [cols[3], String(item.qty)],
    [cols[4], money(item.total)],
  ];
  for (const [col, value] of cells) {
    doc.font(col.align === "left" ? "Helvetica" : "Helvetica-Bold");
    doc.fontSize(9.5).fillColor(col.align === "left" ? COLORS.ink : COLORS.navy);
    doc.text(value, col.x + 8, y + 10, {
      width: col.width - 16,
      align: col.align,
      ellipsis: true,
      lineBreak: false,
    });
  }
  return y + rowH;
}

function drawTotals(
  doc: PDFKit.PDFDocument,
  data: InvoiceData,
  y: number
): number {
  const boxW = 236;
  const x = PAGE_W - MARGIN - boxW;
  let cy = y;
  const row = (label: string, value: string, opts?: { bold?: boolean; big?: boolean; teal?: boolean }) => {
    doc.font(opts?.bold ? "Helvetica-Bold" : "Helvetica");
    doc.fontSize(opts?.big ? 12 : 9.5);
    doc.fillColor(opts?.teal ? COLORS.teal : COLORS.muted);
    doc.text(label, x, cy, { width: boxW - 120 });
    doc.font("Helvetica-Bold").fillColor(COLORS.ink);
    doc.text(value, x + boxW - 120, cy, { width: 120, align: "right" });
    cy += opts?.big ? 22 : 17;
  };
  row("Sub Total", money(data.subTotal));
  row("Tax", data.tax > 0 ? money(data.tax) : "—");

  doc.save();
  doc.rect(x, cy - 2, boxW, 30).fillColor(COLORS.navy).fill();
  doc.restore();
  doc.font("Helvetica-Bold").fontSize(11).fillColor(COLORS.white);
  doc.text("TOTAL", x + 12, cy + 8, { width: boxW - 120 });
  doc.text(money(data.total), x + boxW - 128, cy + 8, {
    width: 116,
    align: "right",
  });
  cy += 40;

  row("Amount Paid", money(data.amountPaid));
  doc.font("Helvetica-Bold").fontSize(10).fillColor(
    data.balanceDue > 0 ? "#B4232B" : COLORS.teal
  );
  doc.text("Balance Due", x, cy, { width: boxW - 120 });
  doc.text(money(data.balanceDue), x + boxW - 120, cy, {
    width: 120,
    align: "right",
  });
  cy += 18;
  return cy;
}

function drawPaymentAndTerms(
  doc: PDFKit.PDFDocument,
  data: InvoiceData,
  startY: number
): void {
  const colW = PAGE_W - 2 * MARGIN - 260;
  let y = startY;

  doc.font("Helvetica-Bold").fontSize(9).fillColor(COLORS.teal);
  doc.text("PAYMENT INFO", MARGIN, y, { characterSpacing: 0.6 });
  y += 15;
  doc.font("Helvetica").fontSize(9.5).fillColor(COLORS.muted);
  const payLines = [
    `Payment status: ${data.paymentStatus}`,
    `Amount paid: ${money(data.amountPaid)}`,
    `Balance due: ${money(data.balanceDue)}`,
    `Bank: Purely Custom Labels · Acct on request`,
  ];
  doc.text(payLines.join("\n"), MARGIN, y, { width: colW, lineGap: 3 });
  y = doc.y + 20;

  doc.font("Helvetica-Bold").fontSize(9).fillColor(COLORS.teal);
  doc.text("TERMS & CONDITIONS", MARGIN, y, { characterSpacing: 0.6 });
  y += 15;
  doc.font("Helvetica").fontSize(8.5).fillColor(COLORS.muted);
  for (const term of TERMS) {
    doc.text(`•  ${term}`, MARGIN, y, { width: colW, lineGap: 2 });
    y = doc.y + 3;
  }
}

function drawFooter(doc: PDFKit.PDFDocument): void {
  const bandTop = PAGE_H - 76;
  // Navy footer wave.
  doc.save();
  doc.moveTo(0, bandTop + 18);
  doc.bezierCurveTo(PAGE_W * 0.32, bandTop - 14, PAGE_W * 0.68, bandTop + 34, PAGE_W, bandTop + 2);
  doc.lineTo(PAGE_W, PAGE_H);
  doc.lineTo(0, PAGE_H);
  doc.closePath();
  doc.fillColor(COLORS.navy).fill();
  doc.restore();

  // Aqua accent along the wave crest.
  doc.save();
  doc.moveTo(0, bandTop + 18);
  doc.bezierCurveTo(PAGE_W * 0.32, bandTop - 14, PAGE_W * 0.68, bandTop + 34, PAGE_W, bandTop + 2);
  doc.lineTo(PAGE_W, bandTop + 9);
  doc.bezierCurveTo(PAGE_W * 0.68, bandTop + 41, PAGE_W * 0.32, bandTop - 7, 0, bandTop + 25);
  doc.closePath();
  doc.fillColor(COLORS.teal).fill();
  doc.restore();

  const iconY = bandTop + 34;
  const icons: [string, string][] = [
    ["P", COMPANY.phone],
    ["W", COMPANY.social],
    ["E", COMPANY.email],
  ];
  let ix = MARGIN;
  doc.fontSize(8.5);
  for (const [letter, value] of icons) {
    doc.save();
    doc.circle(ix + 7, iconY + 4, 8).fillColor(COLORS.teal).fill();
    doc.restore();
    doc.font("Helvetica-Bold").fillColor(COLORS.white).text(letter, ix, iconY, {
      width: 14,
      align: "center",
    });
    doc.font("Helvetica").fillColor(COLORS.tealSoft).text(value, ix + 20, iconY, {
      width: 150,
    });
    ix += 176;
  }

  // Authorised sign line — tucked into the white area just above the footer
  // wave, aligned to the bottom-right corner of the page.
  const signW = 150;
  const signX = PAGE_W - MARGIN - signW;
  const signY = bandTop - 26;
  doc.save();
  doc.moveTo(signX, signY).lineTo(signX + signW, signY);
  doc.lineWidth(0.8).strokeColor(COLORS.muted).stroke();
  doc.restore();
  doc.font("Helvetica-Bold").fontSize(8.5).fillColor(COLORS.muted);
  doc.text("Authorised Sign", signX, signY + 4, {
    width: signW,
    align: "center",
  });
}

/** Render the invoice to an in-memory PDF buffer. */
export function renderInvoicePdf(data: InvoiceData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: "A4",
        margin: 0,
        info: {
          Title: `Invoice ${data.orderId}`,
          Author: COMPANY.name,
          Subject: `Invoice for ${data.client.businessName}`,
        },
      });

      const chunks: Buffer[] = [];
      doc.on("data", (chunk: Buffer) => chunks.push(chunk));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);

      let y = drawHeader(doc, data);
      y = drawParties(doc, data, y);
      y = drawTableHeader(doc, y);

      const maxTableY = PAGE_H - 300;
      data.items.forEach((item, index) => {
        if (y + 30 > maxTableY) {
          doc.addPage();
          y = drawTableHeader(doc, 60);
        }
        y = drawItemRow(doc, item, index, y);
      });

      y += 26;
      const totalsEnd = drawTotals(doc, data, y);
      drawPaymentAndTerms(doc, data, y);
      void totalsEnd;

      drawFooter(doc);
      doc.end();
    } catch (error) {
      reject(error);
    }
  });
}

/** Build + render the invoice for an order in one call. */
export function generateOrderInvoicePdf(order: OrderDoc): Promise<Buffer> {
  return renderInvoicePdf(buildInvoiceData(order));
}
