// netlify/functions/save-contract.js
//
// Recebe os dados do cadastro (cadastro.html) já com o contrato preenchido e:
//   1. Grava o contrato assinado na tabela profeta_signed_contracts
//   2. Grava a escolha de autorização de imagem na tabela profeta_image_authorizations,
//      já vinculada ao contrato acima
//
// Variáveis de ambiente necessárias (configurar no painel da Netlify):
//   SUPABASE_URL              -> https://nixzgeqxludxafeapsdz.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY -> chave service_role do projeto Supabase
//                                (Supabase > Project Settings > API > service_role secret)
//
// IMPORTANTE: a service_role key ignora RLS. Ela só pode existir aqui,
// do lado do servidor. Nunca deve ser exposta no front-end.

const { generateContractPDF } = require("./lib/pdf-contract.js");

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
    },
    body: JSON.stringify(body),
  };
}

function onlyDigits(str = "") {
  return String(str).replace(/\D/g, "");
}

async function supabaseFetch(path, options, baseUrl, serviceKey) {
  const res = await fetch(`${baseUrl}/rest/v1${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      Prefer: "return=representation",
      ...(options.headers || {}),
    },
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    const message =
      data?.message || data?.msg || `Erro Supabase (${res.status})`;
    const err = new Error(message);
    err.status = res.status;
    err.raw = data;
    throw err;
  }

  return data;
}

// Sobe um arquivo binário (o PDF) pro Supabase Storage.
async function supabaseStorageUpload(bucketAndPath, buffer, contentType, baseUrl, serviceKey) {
  const res = await fetch(`${baseUrl}/storage/v1/object/${bucketAndPath}`, {
    method: "POST",
    headers: {
      "Content-Type": contentType,
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      "x-upsert": "true",
    },
    body: buffer,
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    const err = new Error(`Erro ao subir PDF pro Storage (${res.status}): ${errText}`);
    err.status = res.status;
    throw err;
  }

  return true;
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return jsonResponse(200, { ok: true });
  }

  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { error: "Método não permitido" });
  }

  const baseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!baseUrl || !serviceKey) {
    return jsonResponse(500, {
      error:
        "SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY não configuradas nas variáveis de ambiente da Netlify.",
    });
  }

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch {
    return jsonResponse(400, { error: "JSON inválido no corpo da requisição." });
  }

  const {
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
    contractVersion,
    imageAuthorized, // true | false | null (null = não respondeu)
    asaasSubscriptionId,
  } = payload;

  // Validação básica: o essencial pra registro do contrato
  const required = { name, email, cpf, contractHtml };
  const missing = Object.entries(required)
    .filter(([, v]) => !v || String(v).trim() === "")
    .map(([k]) => k);

  if (missing.length) {
    return jsonResponse(400, {
      error: "Campos obrigatórios faltando.",
      missing,
    });
  }

  const remoteIp =
    event.headers["x-nf-client-connection-ip"] ||
    event.headers["client-ip"] ||
    "0.0.0.0";
  const userAgent = event.headers["user-agent"] || "";

  try {
    // 1) Grava o contrato assinado
    const contractRows = await supabaseFetch(
      "/profeta_signed_contracts",
      {
        method: "POST",
        body: JSON.stringify({
          plano: plano || null,
          full_name: name,
          email,
          cpf: onlyDigits(cpf),
          rg: rg || null,
          estado_civil: estadoCivil || null,
          profissao: profissao || null,
          endereco: endereco || null,
          cidade: cidade || null,
          estado: estado || null,
          cep: cep ? onlyDigits(cep) : null,
          phone: phone ? onlyDigits(phone) : null,
          contract_html: contractHtml,
          contract_version: contractVersion || "v1",
          asaas_subscription_id: asaasSubscriptionId || null,
          ip_address: remoteIp,
          user_agent: userAgent,
        }),
      },
      baseUrl,
      serviceKey
    );

    const contractId = contractRows?.[0]?.id;

    // 2) Grava a autorização de imagem (sempre, mesmo que "não autorizo" ou não respondida)
    // Se imageAuthorized vier undefined (campo não enviado), assume false por segurança.
    const authorized = imageAuthorized === true;

    await supabaseFetch(
      "/profeta_image_authorizations",
      {
        method: "POST",
        body: JSON.stringify({
          contract_id: contractId || null,
          full_name: name,
          cpf: onlyDigits(cpf),
          authorized,
          authorization_text_version: "v1",
          ip_address: remoteIp,
        }),
      },
      baseUrl,
      serviceKey
    );

    // 3) Gera o PDF do contrato e sobe pro Supabase Storage.
    // Isso não bloqueia a resposta de sucesso pro cliente caso falhe --
    // o registro em texto na tabela já garante a prova do aceite.
    let pdfPath = null;
    try {
      const pdfBuffer = await generateContractPDF({
        contractId,
        plano: plano || null,
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
        imageAuthorized: authorized,
        createdAt: new Date(),
        ipAddress: remoteIp,
      });

      pdfPath = `contracts/${contractId}.pdf`;
      await supabaseStorageUpload(pdfPath, pdfBuffer, "application/pdf", baseUrl, serviceKey);

      await supabaseFetch(
        `/profeta_signed_contracts?id=eq.${contractId}`,
        {
          method: "PATCH",
          body: JSON.stringify({ pdf_path: pdfPath }),
        },
        baseUrl,
        serviceKey
      );
    } catch (pdfErr) {
      console.error("Erro ao gerar/subir PDF do contrato (registro em texto já salvo):", pdfErr.message);
      pdfPath = null;
    }

    return jsonResponse(200, {
      success: true,
      contractId,
      pdfPath,
    });
  } catch (err) {
    console.error("Erro ao gravar contrato/autorização no Supabase:", err.message, err.raw);
    return jsonResponse(err.status || 500, {
      success: false,
      error: err.message,
      details: err.raw || null,
    });
  }
};
