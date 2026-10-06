const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');

// Template match: left cyan sidebar with geometric decor, white content,
// big cyan INVOICE header, cyan item-table bar, QR + "Thank You" footer.
const P = '#5E17EB';        // sidebar / headings (original template purple — do not retheme)
const YELLOW = '#FFCC00';
const RED = '#FF4848';
const ORANGE = '#FFA51F';
const GREEN = '#00DD4B';
const INK = '#253439';      // body text (dark slate from template)
const ITEM_INK = '#4A423C'; // item name brownish-grey
const FOOT = '#5E17EB';

const PAGE_W = 595.28, PAGE_H = 841.89;
const L = 144, R = 573; // content bounds (right of sidebar)

// Bundled Noto Sans (covers ₹ U+20B9 — Helvetica in PDFKit does not).
// Falls back to built-in Helvetica if font files are missing.
const FONT_DIR = path.join(__dirname, '..', 'fonts');
const FONT_FILES = {
  R: 'NotoSans-Regular.ttf',
  B: 'NotoSans-Bold.ttf',
  I: 'NotoSans-Italic.ttf',
  BI: 'NotoSans-BoldItalic.ttf',
};
const HAS_FONTS = Object.values(FONT_FILES).every(f => fs.existsSync(path.join(FONT_DIR, f)));

function fmtMoney(cur, n) {
  n = Number(n || 0);
  const opts = Number.isInteger(Math.round(n * 100) / 100) && (Math.round(n * 100) % 100 === 0)
    ? {} : { minimumFractionDigits: 2, maximumFractionDigits: 2 };
  return `${cur || '₹'}${n.toLocaleString('en-IN', opts)}`;
}

function fmtDate(iso) {
  if (!iso) return '-';
  const months = ['january', 'february', 'march', 'april', 'may', 'june', 'july',
    'august', 'september', 'october', 'november', 'december'];
  const [y, m, d] = iso.slice(0, 10).split('-');
  const mi = Math.max(1, Math.min(12, Number(m))) - 1;
  return `${months[mi]}/${d}/${y}`;
}

function plus(doc, x, y, s, color) {
  doc.save();
  doc.strokeColor(color).lineWidth(2);
  doc.moveTo(x - s, y).lineTo(x + s, y).stroke();
  doc.moveTo(x, y - s).lineTo(x, y + s).stroke();
  doc.restore();
}

function tri(doc, x, y, s, color) {
  doc.save();
  doc.fillColor(color);
  doc.polygon([x, y - s], [x + s, y + s * 0.6], [x, y + s * 0.6]).fill();
  doc.restore();
}

function dotGrid(doc, x0, y0, cols, rows, dx, dy, r, color) {
  doc.save();
  doc.fillColor(color);
  for (let i = 0; i < cols; i++)
    for (let j = 0; j < rows; j++) {
      doc.circle(x0 + i * dx, y0 + j * dy, r).fill();
    }
  doc.restore();
}

function drawSidebar(doc, logoAbs) {
  const H = PAGE_H;
  doc.save();
  doc.rect(0, 0, 114, H).fill(P);
  doc.restore();

  doc.save();
  doc.rect(0, 0, 114, H).clip();

  // yellow diagonal stripes (top)
  doc.save();
  doc.strokeColor(YELLOW).lineWidth(10);
  for (let i = 0; i < 6; i++) {
    const y = 34 + i * 26;
    doc.moveTo(-12, y).lineTo(96, y - 42).stroke();
  }
  doc.restore();

  // red ring (upper right of sidebar)
  doc.save();
  doc.strokeColor(RED).lineWidth(9);
  doc.circle(103, 142, 13).stroke();
  doc.restore();

  // black dot grid (middle)
  dotGrid(doc, 62, 252, 4, 11, 16, 18, 4.6, '#111111');
  // white plus accents
  plus(doc, 26, 148, 5, '#FFFFFF');
  plus(doc, 58, 232, 5, '#FFFFFF');
  plus(doc, 99, 278, 5, '#FFFFFF');
  plus(doc, 26, 392, 5, '#FFFFFF');

  // orange arc (thick ring; opening faces right like the template)
  doc.save();
  doc.strokeColor(ORANGE).lineWidth(27);
  doc.circle(30, 505, 68).stroke();
  doc.restore();

  // red diagonal slashes over the arc (lower-left -> upper-right)
  doc.save();
  doc.strokeColor(RED).lineWidth(4.5);
  for (let i = 0; i < 8; i++) {
    doc.moveTo(5 + i * 10, 550).lineTo(85 + i * 10, 445).stroke();
  }
  doc.restore();

  tri(doc, 24, 352, 8, GREEN);

  // white dot
  doc.save(); doc.fillColor('#FFFFFF'); doc.circle(40, 690, 7).fill(); doc.restore();
  tri(doc, 96, 718, 7, GREEN);

  // yellow hatch block (lower middle)
  doc.save();
  doc.strokeColor(YELLOW).lineWidth(3.5);
  for (let i = 0; i < 9; i++) {
    doc.moveTo(6 + i * 11, 716).lineTo(56 + i * 11, 652).stroke();
  }
  doc.restore();
  plus(doc, 108, 656, 5, '#FFFFFF');

  // red ring (bottom)
  doc.save();
  doc.strokeColor(RED).lineWidth(13);
  doc.circle(63, 738, 37).stroke();
  doc.restore();

  // black dot grid (bottom, over ring)
  dotGrid(doc, 46, 700, 3, 8, 11, 12.5, 2.8, '#111111');
  plus(doc, 32, 734, 5, '#FFFFFF');

  // white diagonal slashes (bottom)
  doc.save();
  doc.strokeColor('#FFFFFF').lineWidth(6);
  for (let i = 0; i < 5; i++) {
    const y = 800 - i * 15;
    doc.moveTo(74, y).lineTo(130, y - 38).stroke();
  }
  doc.restore();
  tri(doc, 22, 795, 8, GREEN);
  tri(doc, 22, 810, 8, GREEN);

  doc.restore(); // unclip

  // white logo circle on top
  doc.save();
  doc.fillColor('#FFFFFF');
  doc.circle(68, 66, 38).fill();
  doc.restore();
  if (logoAbs && fs.existsSync(logoAbs)) {
    try { doc.image(logoAbs, 68 - 26, 66 - 26, { fit: [52, 52] }); } catch {}
  } else {
    // geometric brand mark (like template's purple glyph)
    doc.save();
    doc.fillColor(P);
    doc.polygon([56, 48], [74, 48], [70, 64], [52, 64]).fill();
    doc.polygon([76, 52], [90, 52], [87, 66], [73, 66]).fill();
    doc.polygon([50, 68], [62, 68], [60, 80], [48, 80]).fill();
    doc.polygon([64, 68], [86, 68], [81, 88], [59, 88]).fill();
    doc.restore();
  }
}

function bizLine(biz) {
  return [biz.business_name, biz.phone, biz.gstin ? `GSTIN: ${biz.gstin}` : '']
    .filter(Boolean).join('   •   ');
}

function generateInvoicePDF(invoice, items, business, customer, payments, qrAbsolutePath, logoAbsolutePath, outPath) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 0 });
    const stream = fs.createWriteStream(outPath);
    doc.pipe(stream);

    // font aliases: embedded Noto Sans when available, else built-ins
    let FR = 'Helvetica', FB = 'Helvetica-Bold', FBI = 'Helvetica-BoldOblique';
    if (HAS_FONTS) {
      try {
        doc.registerFont('InvR', path.join(FONT_DIR, FONT_FILES.R));
        doc.registerFont('InvB', path.join(FONT_DIR, FONT_FILES.B));
        doc.registerFont('InvI', path.join(FONT_DIR, FONT_FILES.I));
        doc.registerFont('InvBI', path.join(FONT_DIR, FONT_FILES.BI));
        FR = 'InvR'; FB = 'InvB'; FBI = 'InvBI';
      } catch { /* fall back to Helvetica */ }
    }

    const showQR = !!(invoice.show_qr && qrAbsolutePath && fs.existsSync(qrAbsolutePath));
    const cur = business.currency || '₹';
    drawSidebar(doc, logoAbsolutePath);

    // ---------- header ----------
    doc.fillColor(P).font(FB).fontSize(46)
      .text('INVOICE', L, 56, { width: R - L, align: 'center', characterSpacing: 1 });
    doc.fontSize(13)
      .text(`INVOICE NO #${invoice.invoice_number}`, L, 110, { width: R - L, align: 'center' });
    if (bizLine(business)) {
      doc.fillColor('#6B7280').font(FR).fontSize(8)
        .text(bizLine(business), L, 130, { width: R - L, align: 'center' });
    }

    // ---------- bill-to + date ----------
    let y = 168;
    doc.fillColor(P).font(FB).fontSize(11).text('invoice to :', L, y);
    doc.fontSize(24).text(String(invoice.cust_name || '-').toUpperCase(), L, y + 14, { width: 280 });
    doc.fillColor(INK).font(FR).fontSize(9.5);
    const addrLines = [invoice.cust_business, invoice.cust_address,
      [invoice.cust_phone, invoice.cust_email].filter(Boolean).join('   '),
      invoice.cust_gstin ? `GSTIN: ${invoice.cust_gstin}` : ''].filter(Boolean).join('\n');
    doc.text(addrLines, L, y + 48, { width: 300, lineGap: 3 });
    const addrBottom = doc.y;

    doc.fillColor(P).font(FB).fontSize(11)
      .text(fmtDate(invoice.invoice_date), L, y + 22, { width: R - L, align: 'right' });
    doc.fillColor('#6B7280').font(FR).fontSize(8);
    let dy = y + 38;
    if (invoice.due_date) {
      doc.text(`Due: ${fmtDate(invoice.due_date)}`, L, dy, { width: R - L, align: 'right' });
      dy += 12;
    }
    if (invoice.status) {
      doc.text(`Status: ${invoice.status}`, L, dy, { width: R - L, align: 'right' });
    }

    // ---------- items table ----------
    let ty = Math.max(306, addrBottom + 20);
    const drawHead = (yy) => {
      doc.save(); doc.rect(L, yy, R - L, 24).fill(P); doc.restore();
      doc.fillColor('#FFFFFF').font(FB).fontSize(12);
      doc.text('Item Description', L + 16, yy + 6, { width: 210 });
      doc.text('Qty', L + 231, yy + 6, { width: 50, align: 'center' });
      doc.text('Price', L + 281, yy + 6, { width: 65, align: 'right' });
      doc.text('Total', L + 351, yy + 6, { width: 65, align: 'right' });
    };
    const newTablePage = () => {
      doc.addPage();
      drawSidebar(doc, logoAbsolutePath);
      ty = 60;
      drawHead(ty);
      return ty + 34;
    };
    drawHead(ty);
    let ry = ty + 34;
    doc.fontSize(11);
    items.forEach((it) => {
      if (ry > PAGE_H - 300) ry = newTablePage();
      doc.fillColor(ITEM_INK).font(FB).fontSize(12)
        .text(it.name || '-', L + 16, ry, { width: 205 });
      let sy = doc.y + 1;
      doc.fillColor('#6B7280').font(FR).fontSize(8);
      const sub = [it.sku ? `SKU: ${it.sku}` : '', it.description || ''].filter(Boolean).join('  •  ');
      if (sub) { doc.text(sub.slice(0, 120), L + 16, sy, { width: 205 }); sy = doc.y; }
      if (Number(it.tax) > 0 || Number(it.discount) > 0) {
        const bits = [];
        if (Number(it.discount) > 0) bits.push(`Disc ${fmtMoney(cur, it.discount)}`);
        if (Number(it.tax) > 0) bits.push(`Tax ${Number(it.tax)}%`);
        doc.fillColor('#9CA3AF').fontSize(7.5).text(bits.join('   •   '), L + 16, sy, { width: 205 });
        sy = doc.y;
      }
      doc.fillColor(INK).font(FR).fontSize(11);
      doc.text(String(it.quantity), L + 231, ry + 2, { width: 50, align: 'center' });
      doc.text(fmtMoney(cur, it.unit_price), L + 281, ry + 2, { width: 65, align: 'right' });
      doc.text(fmtMoney(cur, it.total), L + 351, ry + 2, { width: 65, align: 'right' });
      ry = Math.max(ry + 32, sy + 12);
    });

    // divider
    if (ry > PAGE_H - 280) ry = newTablePage();
    doc.save();
    doc.strokeColor('#111111').lineWidth(1);
    doc.moveTo(L + 8, ry + 4).lineTo(R, ry + 4).stroke();
    doc.restore();

    // subtotal + total bar
    let sy2 = ry + 20;
    doc.fillColor('#111111').font(FB).fontSize(12);
    doc.text('Sub Total', 330, sy2, { width: 110 });
    doc.text(fmtMoney(cur, invoice.subtotal), 450, sy2, { width: 123, align: 'right' });
    if (Number(invoice.discount_total) > 0 || Number(invoice.tax_total) > 0) {
      sy2 += 16;
      doc.fillColor('#6B7280').font(FR).fontSize(9);
      if (Number(invoice.discount_total) > 0) {
        doc.text('Discount', 330, sy2, { width: 110 });
        doc.text(`- ${fmtMoney(cur, invoice.discount_total)}`, 450, sy2, { width: 123, align: 'right' });
        sy2 += 13;
      }
      if (Number(invoice.tax_total) > 0) {
        doc.text('Tax', 330, sy2, { width: 110 });
        doc.text(fmtMoney(cur, invoice.tax_total), 450, sy2, { width: 123, align: 'right' });
        sy2 += 13;
      }
    }
    const barY = sy2 + 14;
    doc.save(); doc.rect(348, barY, R - 348, 28).fill(P); doc.restore();
    doc.fillColor('#FFFFFF').font(FB).fontSize(13);
    doc.text('TOTAL', 360, barY + 7, { width: 100 });
    doc.text(fmtMoney(cur, invoice.total), 458, barY + 7, { width: 105, align: 'right' });

    // ---------- payment QR + thank you ----------
    let by = barY + 56;
    if (by > PAGE_H - 240) {
      doc.addPage();
      drawSidebar(doc, logoAbsolutePath);
      by = 70;
    }
    const qx = 178;
    if (showQR) {
      doc.fillColor(P).font(FB).fontSize(12).text('Payment QR :', qx, by);
      try {
        doc.image(qrAbsolutePath, qx, by + 20, { fit: [120, 120] });
      } catch {
        doc.fillColor('#991B1B').fontSize(9).text('QR unavailable', qx, by + 55);
      }
      by += 20 + 124;
    }
    doc.fillColor(P).font(FB).fontSize(11).text('Payment Method :', 160, by + 2);
    const payLine = business.upi_id ? `UPI ID : ${business.upi_id}`
      : business.bank_name ? `${business.bank_name}${business.account_number ? '  •  ' + business.account_number : ''}${business.ifsc ? '  •  ' + business.ifsc : ''}`
      : '';
    let payBottom = by;
    if (payLine) {
      doc.fillColor('#111111').font(FB).fontSize(10)
        .text(payLine, 160, by + 18, { width: 260 });
      payBottom = doc.y;
    }

    // Thank You (script-style: bold italic purple)
    doc.fillColor(P).font(FBI).fontSize(42)
      .text('Thank', 420, barY + 66, { width: 153, align: 'left' });
    doc.text('You', 446, barY + 112, { width: 127, align: 'left' });

    // ---------- notes / terms (subtle, only if set) ----------
    const drawFooter = () => {
      const fy = PAGE_H - 52;
      doc.fillColor(FOOT).font(FB).fontSize(9);
      doc.text(business.phone || '', L + 36, fy, { width: 140 });
      const loc = [business.city, business.state].filter(Boolean).join(', ');
      doc.text(loc, 300, fy, { width: 140, align: 'left' });
      doc.fontSize(8.5).text(business.website || '', 440, fy, { width: 133, align: 'left' });
    };
    let ny = payBottom + 12;
    const need = (invoice.notes ? 14 : 0) + (invoice.terms ? 14 : 0);
    if (ny + need > PAGE_H - 64) {
      drawFooter(); // complete the full page first
      doc.addPage();
      drawSidebar(doc, logoAbsolutePath);
      ny = 70;
    }
    doc.fillColor('#6B7280').font(FR).fontSize(7.5);
    if (invoice.notes) {
      doc.text(`Notes: ${String(invoice.notes).slice(0, 220)}`, L, ny, { width: R - L });
      ny = doc.y + 3;
    }
    if (invoice.terms) {
      doc.text(`Terms: ${String(invoice.terms).slice(0, 220)}`, L, ny, { width: R - L });
    }
    drawFooter();

    doc.end();
    stream.on('finish', () => resolve(outPath));
    stream.on('error', reject);
  });
}

module.exports = { generateInvoicePDF };
