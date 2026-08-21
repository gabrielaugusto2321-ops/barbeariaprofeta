// netlify/functions/lib/pdf-contract.js
//
// Gera o PDF de um contrato assinado a partir do HTML já preenchido
// (o mesmo texto salvo em profeta_signed_contracts.contract_html) e
// dos dados estruturados do assinante.

const PDFDocument = require("pdfkit");

function decodeEntities(str = "") {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

// Converte o contract_html (parágrafos <p>, alguns com class="term-heading",
// <strong> e <u> dentro) numa lista de { text, heading } simples pra desenhar no PDF.
function htmlToParagraphs(html = "") {
  const matches = [...html.matchAll(/<p([^>]*)>([\s\S]*?)<\/p>/g)];
  return matches.map((m) => {
    const isHeading = /class="term-heading"/.test(m[1]);
    let text = m[2]
      .replace(/<\/?(strong|u|em|b|i)>/g, "")
      .replace(/<[^>]+>/g, "")
      .trim();
    text = decodeEntities(text);
    return { text, heading: isHeading };
  });
}

function formatCPF(cpf = "") {
  const d = cpf.replace(/\D/g, "");
  if (d.length !== 11) return cpf;
  return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
}

function formatDateBR(date) {
  return new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

/**
 * Gera o PDF do contrato em memória e devolve um Buffer.
 * @param {object} data - dados do assinante e do contrato
 * @returns {Promise<Buffer>}
 */
function generateContractPDF(data) {
  const {
    contractId,
    plano,
    name,
    email,
    cpf,
    rg,
    estadoCivil,
    profissao,
    endereco,
    cidade,
    estado,
    cep,
    phone,
    contractHtml,
    imageAuthorized,
    createdAt,
    ipAddress,
  } = data;

  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: "A4", margin: 56 });
      const chunks = [];
      doc.on("data", (chunk) => chunks.push(chunk));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);

      const goldColor = "#8a6a3d";
      const textColor = "#1a1a1a";
      const dimColor = "#555555";

      // Cabeçalho
      doc
        .font("Helvetica-Bold")
        .fontSize(18)
        .fillColor(textColor)
        .text("PROFETA EXPERIENCE", { align: "center" });
      doc
        .font("Helvetica")
        .fontSize(10)
        .fillColor(dimColor)
        .text("Contrato de Adesão — A R CASTILHO LTDA", { align: "center" });
      doc.moveDown(1.2);

      // Linha divisória
      doc
        .strokeColor(goldColor)
        .lineWidth(1)
        .moveTo(doc.page.margins.left, doc.y)
        .lineTo(doc.page.width - doc.page.margins.right, doc.y)
        .stroke();
      doc.moveDown(1);

      // Bloco de dados do assinante
      doc.font("Helvetica-Bold").fontSize(11).fillColor(textColor).text("Dados do assinante");
      doc.moveDown(0.3);
      doc.font("Helvetica").fontSize(9.5).fillColor(textColor);

      const rows = [
        ["Nome completo", name],
        ["CPF", formatCPF(cpf)],
        ["RG", rg],
        ["Estado civil", estadoCivil],
        ["Profissão", profissao],
        ["E-mail", email],
        ["Telefone", phone],
        ["Endereço", endereco],
        ["Cidade/Estado", cidade && estado ? `${cidade} - ${estado}` : ""],
        ["CEP", cep],
        ["Plano contratado", plano],
      ];
      rows.forEach(([label, value]) => {
        if (!value) return;
        doc.font("Helvetica-Bold").text(`${label}: `, { continued: true });
        doc.font("Helvetica").text(value);
      });

      doc.moveDown(1);
      doc
        .strokeColor("#cccccc")
        .lineWidth(0.5)
        .moveTo(doc.page.margins.left, doc.y)
        .lineTo(doc.page.width - doc.page.margins.right, doc.y)
        .stroke();
      doc.moveDown(1);

      // Corpo do contrato
      doc.font("Helvetica-Bold").fontSize(11).fillColor(textColor).text("Termo de Aceite");
      doc.moveDown(0.5);

      const paragraphs = htmlToParagraphs(contractHtml);
      paragraphs.forEach((p) => {
        if (!p.text) return;
        if (p.heading) {
          doc.moveDown(0.4);
          doc.font("Helvetica-Bold").fontSize(10).fillColor(goldColor).text(p.text);
          doc.fillColor(textColor);
        } else {
          doc.font("Helvetica").fontSize(9.3).text(p.text, { align: "justify" });
        }
        doc.moveDown(0.35);
      });

      // Autorização de imagem
      doc.moveDown(0.6);
      doc
        .strokeColor("#cccccc")
        .lineWidth(0.5)
        .moveTo(doc.page.margins.left, doc.y)
        .lineTo(doc.page.width - doc.page.margins.right, doc.y)
        .stroke();
      doc.moveDown(0.6);
      doc.font("Helvetica-Bold").fontSize(10).fillColor(textColor).text("Autorização de uso de imagem: ", {
        continued: true,
      });
      doc
        .font("Helvetica")
        .fillColor(imageAuthorized ? "#2e7d32" : "#8a1c1c")
        .text(imageAuthorized ? "AUTORIZADO pelo assinante" : "NÃO autorizado pelo assinante");
      doc.fillColor(textColor);

      // Rodapé com metadados de comprovação
      doc.moveDown(1.2);
      doc.font("Helvetica").fontSize(8).fillColor(dimColor);
      doc.text(`Documento gerado automaticamente em ${formatDateBR(createdAt || new Date())}.`);
      if (contractId) doc.text(`Identificador do registro: ${contractId}`);
      if (ipAddress) doc.text(`Endereço IP no momento da assinatura: ${ipAddress}`);
      doc.text(
        "Este documento é uma representação em PDF do aceite eletrônico registrado no momento da assinatura, com todos os dados informados pelo assinante."
      );

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = { generateContractPDF };
