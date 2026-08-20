// netlify/functions/save-exclusive-lead.js
//
// Recebe as respostas do questionário de interesse no Profeta Exclusive
// (exclusive.html) e grava na tabela profeta_exclusive_leads.
//
// Variáveis de ambiente necessárias (as mesmas já configuradas pro save-contract.js):
//   SUPABASE_URL              -> https://nixzgeqxludxafeapsdz.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY -> chave service_role do projeto Supabase

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
    name,
    phone,
    email,
    clienteAtual,
    frequencia,
    melhorHorario,
    interesses,
    observacoes,
  } = payload;

  const required = { name, phone, email };
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
    const rows = await supabaseFetch(
      "/profeta_exclusive_leads",
      {
        method: "POST",
        body: JSON.stringify({
          full_name: name,
          phone: onlyDigits(phone),
          email,
          cliente_atual: clienteAtual || null,
          frequencia: frequencia || null,
          melhor_horario: melhorHorario || null,
          interesses: Array.isArray(interesses) ? interesses : [],
          observacoes: observacoes || null,
          ip_address: remoteIp,
          user_agent: userAgent,
        }),
      },
      baseUrl,
      serviceKey
    );

    return jsonResponse(200, {
      success: true,
      leadId: rows?.[0]?.id || null,
    });
  } catch (err) {
    console.error("Erro ao gravar lead Exclusive no Supabase:", err.message, err.raw);
    return jsonResponse(err.status || 500, {
      success: false,
      error: err.message,
      details: err.raw || null,
    });
  }
};
