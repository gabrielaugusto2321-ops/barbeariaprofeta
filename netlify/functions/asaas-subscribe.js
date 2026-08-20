// netlify/functions/asaas-subscribe.js
//
// Recebe os dados do formulário de cadastro (cadastro.html) e:
//   1. Cria (ou reaproveita) o cliente no Asaas -> POST /v3/customers
//   2. Cria a assinatura recorrente no cartão   -> POST /v3/subscriptions
//   3. Devolve sucesso/erro pro front-end
//
// Variável de ambiente necessária (configurar no painel da Netlify):
//   ASAAS_API_KEY   -> sua chave de API do Asaas (produção ou sandbox)
//   ASAAS_ENV       -> "sandbox" ou "production" (default: sandbox)

const ASAAS_BASE_URL = {
  sandbox: "https://api-sandbox.asaas.com/v3",
  production: "https://api.asaas.com/v3",
};

// Mapa de planos -> preço. O preço NUNCA vem do front-end (evita manipulação);
// o front manda só o código do plano, e a gente resolve o valor real aqui.
const PLANOS = {
  "basic-corte":  { value: 169.90, description: "Profeta Experience - Basic (Corte)" },
  "basic-barba":  { value: 179.90, description: "Profeta Experience - Basic (Barba)" },
  "basic-combo":  { value: 289.90, description: "Profeta Experience - Basic (Corte + Barba)" },
  "black-corte":  { value: 189.90, description: "Profeta Experience - Black (Corte)" },
  "black-barba":  { value: 219.90, description: "Profeta Experience - Black (Barba)" },
  "black-combo":  { value: 339.90, description: "Profeta Experience - Black (Corte + Barba)" },
  // Fallback: mantém o valor histórico pra quem entrar pelo CTA final sem plano definido.
  "legacy-289":   { value: 289.90, description: "Profeta Experience - Assinatura mensal" },
};
const CYCLE = "MONTHLY";

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      // Ajuste o domínio abaixo depois de subir no Hostinger, se quiser travar o CORS.
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

async function asaasFetch(path, options, apiKey, baseUrl) {
  const res = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      access_token: apiKey,
      ...(options.headers || {}),
    },
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    const message =
      data?.errors?.map((e) => e.description).join(" | ") ||
      data?.message ||
      `Erro Asaas (${res.status})`;
    const err = new Error(message);
    err.status = res.status;
    err.raw = data;
    throw err;
  }

  return data;
}

exports.handler = async (event) => {
  // Preflight CORS
  if (event.httpMethod === "OPTIONS") {
    return jsonResponse(200, { ok: true });
  }

  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { error: "Método não permitido" });
  }

  const apiKey = process.env.ASAAS_API_KEY;
  const env = process.env.ASAAS_ENV === "production" ? "production" : "sandbox";
  const baseUrl = ASAAS_BASE_URL[env];

  if (!apiKey) {
    return jsonResponse(500, {
      error: "ASAAS_API_KEY não configurada nas variáveis de ambiente da Netlify.",
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
    email,
    cpf,
    phone,
    postalCode,
    addressNumber,
    cardName,
    cardNumber,
    cardExpiryMonth,
    cardExpiryYear,
    cardCvv,
    plano,
  } = payload;

  // Validação básica dos campos obrigatórios
  const required = { name, email, cpf, phone, cardName, cardNumber, cardExpiryMonth, cardExpiryYear, cardCvv };
  const missing = Object.entries(required)
    .filter(([, v]) => !v || String(v).trim() === "")
    .map(([k]) => k);

  if (missing.length) {
    return jsonResponse(400, {
      error: "Campos obrigatórios faltando.",
      missing,
    });
  }

  // Resolve o plano e o preço real no servidor (nunca confia no valor vindo do front).
  const planoInfo = PLANOS[plano] || PLANOS["legacy-289"];

  const cpfDigits = onlyDigits(cpf);
  const phoneDigits = onlyDigits(phone);

  try {
    // 1) Cria o cliente no Asaas
    //    (o Asaas não duplica automaticamente por CPF, então buscamos antes)
    const existing = await asaasFetch(
      `/customers?cpfCnpj=${cpfDigits}`,
      { method: "GET" },
      apiKey,
      baseUrl
    );

    let customerId;
    if (existing?.data?.length > 0) {
      customerId = existing.data[0].id;
    } else {
      const customer = await asaasFetch(
        "/customers",
        {
          method: "POST",
          body: JSON.stringify({
            name,
            email,
            cpfCnpj: cpfDigits,
            mobilePhone: phoneDigits,
            postalCode: postalCode ? onlyDigits(postalCode) : undefined,
            addressNumber: addressNumber || undefined,
          }),
        },
        apiKey,
        baseUrl
      );
      customerId = customer.id;
    }

    // 2) Cria a assinatura recorrente no cartão de crédito
    const remoteIp =
      event.headers["x-nf-client-connection-ip"] ||
      event.headers["client-ip"] ||
      "127.0.0.1";

    const subscription = await asaasFetch(
      "/subscriptions",
      {
        method: "POST",
        body: JSON.stringify({
          customer: customerId,
          billingType: "CREDIT_CARD",
          value: planoInfo.value,
          cycle: CYCLE,
          description: planoInfo.description,
          nextDueDate: new Date().toISOString().split("T")[0],
          creditCard: {
            holderName: cardName,
            number: onlyDigits(cardNumber),
            expiryMonth: String(cardExpiryMonth).padStart(2, "0"),
            expiryYear: String(cardExpiryYear).length === 2
              ? `20${cardExpiryYear}`
              : String(cardExpiryYear),
            ccv: String(cardCvv),
          },
          creditCardHolderInfo: {
            name: cardName,
            email,
            cpfCnpj: cpfDigits,
            postalCode: postalCode ? onlyDigits(postalCode) : "87010000",
            addressNumber: addressNumber || "0",
            phone: phoneDigits,
          },
          remoteIp,
        }),
      },
      apiKey,
      baseUrl
    );

    return jsonResponse(200, {
      success: true,
      customerId,
      subscriptionId: subscription.id,
      status: subscription.status,
      value: planoInfo.value,
      plano: plano || "legacy-289",
    });
  } catch (err) {
    console.error("Erro ao processar assinatura Asaas:", err.message, err.raw);
    return jsonResponse(err.status || 500, {
      success: false,
      error: err.message,
      details: err.raw || null,
    });
  }
};
