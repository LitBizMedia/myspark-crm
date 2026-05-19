// lib-aws/contract-pdf.js
// Generate signed contract PDF using pdfkit.
//
// Multi-page output:
//   - Header section: business + title + recipient + dates
//   - Body content: HTML stripped to structured text
//   - Signature page: typed name + agreement statement
//   - Audit certificate: envelope id, IP, user agent, timestamps, SHA-256
//
// Returns { buffer, sha256 }

const PDFDocument = require('pdfkit');
const crypto = require('crypto');

const MARGIN = 50;
const PAGE_WIDTH = 612;  // US Letter
const PAGE_HEIGHT = 792;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;

// Strip HTML tags but preserve block-level structure as line breaks
function htmlToStructuredText(html) {
  if (!html || typeof html !== 'string') return [];

  // Normalize whitespace
  var text = html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li)>/gi, '\n\n')
    .replace(/<li[^>]*>/gi, '  • ')
    .replace(/<h1[^>]*>/gi, '\n\n###H1### ')
    .replace(/<h2[^>]*>/gi, '\n\n###H2### ')
    .replace(/<h3[^>]*>/gi, '\n\n###H3### ')
    .replace(/<strong[^>]*>|<b[^>]*>/gi, '###B### ')
    .replace(/<\/strong>|<\/b>/gi, ' ###/B###')
    .replace(/<[^>]+>/g, '')          // strip remaining tags
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  // Split into blocks; each block is { type, text }
  var blocks = [];
  var paragraphs = text.split(/\n\n+/);
  paragraphs.forEach(function(p) {
    p = p.trim();
    if (!p) return;
    if (p.startsWith('###H1### ')) {
      blocks.push({ type: 'h1', text: p.slice(9).trim() });
    } else if (p.startsWith('###H2### ')) {
      blocks.push({ type: 'h2', text: p.slice(9).trim() });
    } else if (p.startsWith('###H3### ')) {
      blocks.push({ type: 'h3', text: p.slice(9).trim() });
    } else if (p.startsWith('  • ')) {
      // List
      var items = p.split('  • ').filter(Boolean);
      items.forEach(function(item) {
        blocks.push({ type: 'li', text: item.trim() });
      });
    } else {
      blocks.push({ type: 'p', text: p });
    }
  });

  return blocks;
}

function formatDateTime(d) {
  if (!d) return '';
  var dt = d instanceof Date ? d : new Date(d);
  if (isNaN(dt.getTime())) return '';
  return dt.toUTCString();
}

function generateContractPdf(opts) {
  return new Promise(function(resolve, reject) {
    var doc = new PDFDocument({
      size: 'LETTER',
      margins: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN },
      info: {
        Title: opts.title,
        Author: opts.businessName,
        Subject: 'Signed contract',
        Creator: 'MySpark+',
        CreationDate: opts.signedAt
      }
    });

    var chunks = [];
    doc.on('data', function(chunk) { chunks.push(chunk); });
    doc.on('end', function() {
      var buffer = Buffer.concat(chunks);
      var sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
      resolve({ buffer: buffer, sha256: sha256 });
    });
    doc.on('error', reject);

    try {
      // === Page 1: Header ===
      doc.fillColor('#6b21ea')
         .font('Helvetica-Bold').fontSize(22)
         .text(opts.businessName || 'Document', { align: 'left' });
      doc.moveDown(0.3);
      doc.fillColor('#1a1030').fontSize(16)
         .text(opts.title || 'Contract', { align: 'left' });

      doc.moveDown(0.8);
      doc.strokeColor('#e5e7eb').lineWidth(1)
         .moveTo(MARGIN, doc.y).lineTo(PAGE_WIDTH - MARGIN, doc.y).stroke();
      doc.moveDown(0.8);

      // Metadata grid
      doc.fillColor('#5a4d7a').font('Helvetica').fontSize(9);
      var metaY = doc.y;
      doc.text('RECIPIENT', MARGIN, metaY, { width: 250 });
      doc.text('SENT BY',   MARGIN + 270, metaY, { width: 250 });
      doc.moveDown(0.2);
      var lineY = doc.y;
      doc.fillColor('#1a1030').font('Helvetica-Bold').fontSize(11);
      doc.text(opts.recipientName || '', MARGIN, lineY, { width: 250 });
      doc.text(opts.senderName || '',    MARGIN + 270, lineY, { width: 250 });
      doc.moveDown(0.2);
      var emailY = doc.y;
      doc.fillColor('#5a4d7a').font('Helvetica').fontSize(9);
      doc.text(opts.recipientEmail || '', MARGIN, emailY, { width: 250 });
      doc.moveDown(1.2);

      var dateY = doc.y;
      doc.fillColor('#5a4d7a').font('Helvetica').fontSize(9);
      doc.text('SENT',    MARGIN, dateY, { width: 250 });
      doc.text('SIGNED',  MARGIN + 270, dateY, { width: 250 });
      doc.moveDown(0.2);
      var dateValY = doc.y;
      doc.fillColor('#1a1030').font('Helvetica').fontSize(10);
      doc.text(formatDateTime(opts.sentAt) || '—', MARGIN, dateValY, { width: 250 });
      doc.text(formatDateTime(opts.signedAt) || '—', MARGIN + 270, dateValY, { width: 250 });
      doc.moveDown(1.5);

      doc.strokeColor('#e5e7eb').lineWidth(1)
         .moveTo(MARGIN, doc.y).lineTo(PAGE_WIDTH - MARGIN, doc.y).stroke();
      doc.moveDown(1);

      // === Body content ===
      var blocks = htmlToStructuredText(opts.bodyHtml);
      blocks.forEach(function(block) {
        // Check if we need a new page (rough estimate)
        if (doc.y > PAGE_HEIGHT - 120) doc.addPage();

        switch (block.type) {
          case 'h1':
            doc.fillColor('#1a1030').font('Helvetica-Bold').fontSize(18);
            doc.text(stripMarkers(block.text), { width: CONTENT_WIDTH });
            doc.moveDown(0.5);
            break;
          case 'h2':
            doc.fillColor('#1a1030').font('Helvetica-Bold').fontSize(15);
            doc.text(stripMarkers(block.text), { width: CONTENT_WIDTH });
            doc.moveDown(0.4);
            break;
          case 'h3':
            doc.fillColor('#1a1030').font('Helvetica-Bold').fontSize(13);
            doc.text(stripMarkers(block.text), { width: CONTENT_WIDTH });
            doc.moveDown(0.3);
            break;
          case 'li':
            doc.fillColor('#1a1030').font('Helvetica').fontSize(11);
            doc.text('• ' + stripMarkers(block.text), {
              width: CONTENT_WIDTH,
              indent: 10
            });
            doc.moveDown(0.2);
            break;
          default:
            doc.fillColor('#1a1030').font('Helvetica').fontSize(11);
            doc.text(stripMarkers(block.text), {
              width: CONTENT_WIDTH,
              lineGap: 2
            });
            doc.moveDown(0.6);
        }
      });

      // === Signature section ===
      if (doc.y > PAGE_HEIGHT - 250) doc.addPage();
      doc.moveDown(2);

      doc.strokeColor('#1a1030').lineWidth(2)
         .moveTo(MARGIN, doc.y).lineTo(PAGE_WIDTH - MARGIN, doc.y).stroke();
      doc.moveDown(0.5);

      doc.fillColor('#1a1030').font('Helvetica-Bold').fontSize(14)
         .text('Electronic Signature', MARGIN);
      doc.moveDown(0.5);

      doc.fillColor('#5a4d7a').font('Helvetica').fontSize(10)
         .text(opts.agreeText || 'I agree to electronically sign this document.', {
           width: CONTENT_WIDTH
         });
      doc.moveDown(1);

      // Signature line with typed name in script-like font
      doc.fillColor('#1a1030').font('Helvetica-Oblique').fontSize(22)
         .text(opts.signedTypedName || '', MARGIN, doc.y, { width: CONTENT_WIDTH });
      doc.moveDown(0.2);

      doc.strokeColor('#1a1030').lineWidth(0.5)
         .moveTo(MARGIN, doc.y).lineTo(MARGIN + 300, doc.y).stroke();
      doc.moveDown(0.3);

      doc.fillColor('#5a4d7a').font('Helvetica').fontSize(9)
         .text('Signed by ' + (opts.recipientName || '') + ' on ' + formatDateTime(opts.signedAt));

      // === Audit certificate page ===
      doc.addPage();

      doc.fillColor('#6b21ea').font('Helvetica-Bold').fontSize(18)
         .text('Audit Certificate', { align: 'center' });
      doc.moveDown(0.3);
      doc.fillColor('#5a4d7a').font('Helvetica').fontSize(10)
         .text('This certificate provides legal evidence of the electronic signature.', { align: 'center' });
      doc.moveDown(2);

      // Audit table
      var rows = [
        ['Envelope ID',       opts.envelopeId || ''],
        ['Document Title',    opts.title || ''],
        ['Recipient Name',    opts.recipientName || ''],
        ['Recipient Email',   opts.recipientEmail || ''],
        ['Sent By',           opts.senderName || ''],
        ['Sent At (UTC)',     formatDateTime(opts.sentAt)],
        ['Signed Typed Name', opts.signedTypedName || ''],
        ['Signed At (UTC)',   formatDateTime(opts.signedAt)],
        ['Signer IP Address', opts.signedIp || 'not recorded'],
        ['Signer User Agent', (opts.signedUserAgent || '').slice(0, 100)]
      ];

      rows.forEach(function(row) {
        doc.fillColor('#5a4d7a').font('Helvetica').fontSize(9)
           .text(row[0], MARGIN, doc.y, { width: 160, continued: false });
        doc.fillColor('#1a1030').font('Helvetica').fontSize(10)
           .text(row[1] || '—', MARGIN + 170, doc.y - doc.currentLineHeight(), {
             width: CONTENT_WIDTH - 170
           });
        doc.moveDown(0.6);
      });

      doc.moveDown(1);
      doc.strokeColor('#e5e7eb').lineWidth(1)
         .moveTo(MARGIN, doc.y).lineTo(PAGE_WIDTH - MARGIN, doc.y).stroke();
      doc.moveDown(1);

      // SHA-256 hash placeholder. The actual hash is the hash of THIS PDF,
      // which we cannot include in this PDF (chicken-and-egg). Instead, we
      // include a verification URL. The hash is stored on the envelope row
      // and exposed via the verify endpoint.
      doc.fillColor('#1a1030').font('Helvetica-Bold').fontSize(11)
         .text('Verify this document', { align: 'left' });
      doc.moveDown(0.3);
      doc.fillColor('#5a4d7a').font('Helvetica').fontSize(9)
         .text('To verify this document has not been altered, compute the SHA-256 hash of this PDF and compare it to the hash stored at:', {
           width: CONTENT_WIDTH
         });
      doc.moveDown(0.3);
      doc.fillColor('#6b21ea').font('Courier').fontSize(9)
         .text('https://api.mysparkplus.app/api/contracts/public/verify?envelope_id=' + opts.envelopeId, {
           width: CONTENT_WIDTH
         });
      doc.moveDown(0.5);
      doc.fillColor('#5a4d7a').font('Helvetica').fontSize(9)
         .text('On macOS or Linux, run: shasum -a 256 signed.pdf', {
           width: CONTENT_WIDTH
         });

      doc.moveDown(2);
      doc.fillColor('#9ca3af').font('Helvetica').fontSize(8)
         .text('Generated by MySpark+ on ' + new Date().toUTCString(), { align: 'center' });

      doc.end();
    } catch(e) {
      reject(e);
    }
  });
}

function stripMarkers(s) {
  return String(s || '')
    .replace(/###B### /g, '')
    .replace(/ ###\/B###/g, '');
}

module.exports = {
  generateContractPdf: generateContractPdf,
  htmlToStructuredText: htmlToStructuredText
};
