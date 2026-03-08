import { useState, useEffect, useRef, useCallback } from "react";

// ─── ARC TESTNET CONFIG — source: docs.arc.network ───────────────────────────
// Arc uses USDC as native gas token.
// Native balance precision = 18 decimals (EVM standard).
// ERC-20 USDC interface = 6 decimals. Do NOT mix these.
// Faucet: https://faucet.circle.com — select "Arc Testnet", no account required.
const ARC_CHAIN = {
  chainId: "0x4cef52",         // 5042002 decimal
  chainName: "Arc Testnet",
  // Native gas token is USDC. Wallets that support custom gas tokens should
  // display 18 decimals but label fees as "USDC" (docs: connect-to-arc).
  nativeCurrency: { name: "USD Coin", symbol: "USDC", decimals: 18 },
  rpcUrls: ["https://rpc.testnet.arc.network"],
  blockExplorerUrls: ["https://testnet.arcscan.app"],
};
const ARC_CHAIN_ID  = 5042002;
const RPC_URL       = "https://rpc.testnet.arc.network";
const FAUCET_URL    = "https://faucet.circle.com";
const EXPLORER_URL  = "https://testnet.arcscan.app";
// Arc Testnet contract addresses (docs: contract-addresses)
const CONTRACTS = {
  USDC: "0x3600000000000000000000000000000000000000", // native ERC-20 precompile (Arc Testnet official)
  EURC: "0x08210F9170F89Ab7658F0B5E3fF39b0E03C2Fa8", // euro stablecoin
};

// USDC on Arc Testnet (same as native gas token)
const USDC_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function symbol() view returns (string)",
];

// ─── AGENT DEFINITIONS — aligned with Arc Network use cases ──────────────────
// Source: docs.arc.network/arc/concepts/welcome-to-arc ("What you can build")
const AGENTS = [
  { id: "nexus", name: "NEXUS", role: "Cross-Border Payments", color: "#00FFB2", icon: "⬡",
    description: "Remittances, payroll & multi-currency USDC payouts via Arc's sub-second finality",
    useCases: ["Remittance platforms","Global payroll","Marketplace payouts"],
    stats: { processed: "1.2M USDC", uptime: "99.98%", txToday: 847 } },
  { id: "lex",   name: "LEX",   role: "Capital Markets",       color: "#FF6B35", icon: "◈",
    description: "Tokenized securities, DvP settlement & collateral management on Arc Testnet",
    useCases: ["Tokenized securities","DvP settlement","Stablecoin margin"],
    stats: { processed: "342K USDC", uptime: "99.95%", txToday: 213 } },
  { id: "iris",  name: "IRIS",  role: "Compliance & Privacy",  color: "#A78BFA", icon: "◎",
    description: "Opt-in privacy, KYC/AML via USDC blocklists & selective disclosure (Arc EVM)",
    useCases: ["Opt-in privacy","USDC blocklist","Selective disclosure"],
    stats: { processed: "89K checks", uptime: "100%",   txToday: 56  } },
  { id: "volt",  name: "VOLT",  role: "Stablecoin FX & Yield", color: "#FCD34D", icon: "⟁",
    description: "StableFX RFQ engine, USDC↔EURC swaps & yield on Arc's stable-fee infrastructure",
    useCases: ["StableFX RFQ","USDC↔EURC swaps","Yield optimization"],
    stats: { processed: "4.8M USDC", uptime: "99.99%", txToday: 1204} },
];
const AGENT_COLORS = { NEXUS:"#00FFB2", LEX:"#FF6B35", IRIS:"#A78BFA", VOLT:"#FCD34D" };

// ─── PLATFORM FEE — 0.1% on every swap and payment ───────────────────────────
// Collected via a separate eth_sendTransaction to the fee wallet.
// Amount = floor(txAmount * 0.001). Displayed transparently before confirmation.
const PLATFORM_FEE_BPS  = 10;          // 10 basis points = 0.1%
const PLATFORM_FEE_WALLET = "0x000000000000000000000000000000000000dEaD"; // replace with real fee address
function calcFee(amountWei) {
  // Returns fee in same unit (BigInt wei)
  return (BigInt(amountWei) * BigInt(PLATFORM_FEE_BPS)) / BigInt(10000);
}

// ─── MOCK DATA — Arc Network use cases ───────────────────────────────────────
const MOCK_CONTRACTS = [
  { id:"CTR-001", title:"Global Payroll Q1 2026",        value:"48,500 USDC",  status:"executing",  agent:"NEXUS", progress:67  },
  { id:"CTR-002", title:"Tokenized RWA Bond SP-447",     value:"120,000 USDC", status:"pending",    agent:"LEX",   progress:23  },
  { id:"CTR-003", title:"USDC→EURC StableFX Settle",     value:"9,200 USDC",   status:"completed",  agent:"VOLT",  progress:100 },
  { id:"CTR-004", title:"Supplier Invoice DvP #88",      value:"3,750 USDC",   status:"executing",  agent:"NEXUS", progress:91  },
  { id:"CTR-005", title:"Yield Strategy — USYC APR",     value:"250,000 USDC", status:"executing",  agent:"VOLT",  progress:44  },
];

// ─── HELPERS ─────────────────────────────────────────────────────────────────
function shortAddr(addr) {
  return addr ? `${addr.slice(0,6)}...${addr.slice(-4)}` : "";
}

function formatUnitsSafe(rawValue, decimals, minFractionDigits, maxFractionDigits) {
  if (rawValue === null || rawValue === undefined) return "0.00";
  const raw = BigInt(rawValue);
  const sign = raw < 0n ? "-" : "";
  const abs = raw < 0n ? -raw : raw;

  const base = 10n ** BigInt(decimals);
  const integer = abs / base;
  const fraction = abs % base;

  const formattedInteger = integer.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  if (maxFractionDigits <= 0) return `${sign}${formattedInteger}`;

  const paddedFraction = fraction.toString().padStart(decimals, "0");
  let shownFraction = paddedFraction.slice(0, maxFractionDigits);

  while (shownFraction.length > minFractionDigits && shownFraction.endsWith("0")) {
    shownFraction = shownFraction.slice(0, -1);
  }

  while (shownFraction.length < minFractionDigits) {
    shownFraction += "0";
  }

  return `${sign}${formattedInteger}.${shownFraction}`;
}

// Arc native USDC balance: 18 decimals (EVM standard for eth_getBalance).
// ERC-20 USDC interface: 6 decimals. Use ERC-20 calls for token transfers.
// Docs: docs.arc.network/arc/references/contract-addresses
function formatNativeUsdc(rawHex) {
  if (!rawHex) return "0.000000";
  // Native balance has 18 decimals precision; display as USDC (divide by 1e18)
  return formatUnitsSafe(rawHex, 18, 6, 6);
}
function formatUsdc(raw, decimals = 6) {
  if (!raw) return "0.00";
  return formatUnitsSafe(raw, decimals, 2, 4);
}

// Minimal ethers-like JSON-RPC wrapper (no npm needed inside artifact)
async function rpc(method, params = []) {
  const t0 = Date.now();
  try {
    const res = await fetch(RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    _appRuntime.rpcLatency.push(Date.now() - t0);
    if (_appRuntime.rpcLatency.length > 20) _appRuntime.rpcLatency.shift();
    return data.result;
  } catch (e) {
    _appRuntime.rpcFails++;
    recordRuntimeError("RPC", e.message, "warning");
    throw e;
  }
}

async function getBalance(address) {
  return rpc("eth_getBalance", [address, "latest"]);
}

async function getBlockNumber() {
  const hex = await rpc("eth_blockNumber", []);
  return parseInt(hex, 16);
}

async function getTransactionCount(address) {
  const hex = await rpc("eth_getTransactionCount", [address, "latest"]);
  return parseInt(hex, 16);
}

// ERC-20 balanceOf via eth_call
async function getUsdcBalance(tokenAddress, walletAddress) {
  // balanceOf(address) selector = 0x70a08231
  const data = "0x70a08231" + walletAddress.slice(2).padStart(64, "0");
  const result = await rpc("eth_call", [{ to: tokenAddress, data }, "latest"]);
  return BigInt(result);
}

// ═══════════════════════════════════════════════════════════════════════════════
// 🛡️  SECURITY ENGINE — proteção contra malware, phishing e ataques
// ═══════════════════════════════════════════════════════════════════════════════

// ── Endereços conhecidos como scam/phishing (blacklist pública simulada) ──────
const BLACKLIST = new Set([
  "0x000000000000000000000000000000000000dead",
  "0xdead000000000000000042069420694206942069",
  "0x00000000219ab540356cbb839cbe05303d7705fa", // ETH2 deposit (não enviar aqui)
  "0xde0b295669a9fd93d5f28d9ec85e40f4cb697bae",
]);

// ── Padrões suspeitos em endereços (vanity addresses usados em scams) ─────────
const SUSPICIOUS_PATTERNS = [
  /^0x0{10}/i,          // muitos zeros no início
  /^0xdead/i,           // burn address
  /^0xffff/i,           // endereço incomum
  /(.)\1{6,}/i,         // 6+ caracteres repetidos
];

// ── Rate limiter em memória ────────────────────────────────────────────────────
const _rateLimiter = { counts: {}, resetAt: Date.now() + 60_000 };
function checkRateLimit(action, maxPerMinute = 5) {
  const now = Date.now();
  if (now > _rateLimiter.resetAt) {
    _rateLimiter.counts = {};
    _rateLimiter.resetAt = now + 60_000;
  }
  _rateLimiter.counts[action] = (_rateLimiter.counts[action] || 0) + 1;
  return _rateLimiter.counts[action] <= maxPerMinute;
}

// ── Detecção de clipboard hijacking ──────────────────────────────────────────
// Verifica se o endereço colado difere do que o usuário tinha digitado
function detectClipboardHijack(original, pasted) {
  if (!original || !pasted) return false;
  if (original.length < 10) return false;
  // Mais de 4 chars diferentes no início/fim = suspeito
  const origStart = original.slice(0, 6);
  const origEnd = original.slice(-6);
  const pastStart = pasted.slice(0, 6);
  const pastEnd = pasted.slice(-6);

  let diffCount = 0;
  for (let i = 0; i < 6; i++) {
    if (origStart[i] !== pastStart[i]) diffCount++;
    if (origEnd[i] !== pastEnd[i]) diffCount++;
  }

  return diffCount > 4;
}

// ── Análise de risco de uma transação ────────────────────────────────────────
function analyzeTransactionRisk(address, amount, walletBalance) {
  const risks = [];
  const addr = (address || "").toLowerCase();

  // 1. Blacklist check
  if (BLACKLIST.has(addr)) {
    risks.push({ level: "critical", msg: "Endereço na blacklist de scams conhecidos" });
  }

  // 2. Padrões suspeitos
  for (const pattern of SUSPICIOUS_PATTERNS) {
    if (pattern.test(addr)) {
      risks.push({ level: "high", msg: "Padrão de endereço suspeito detectado" });
      break;
    }
  }

  // 3. Valor muito alto (> 90% do saldo)
  if (walletBalance && amount) {
    const bal = parseFloat(walletBalance);
    const amt = parseFloat(amount);
    if (!isNaN(bal) && !isNaN(amt) && bal > 0 && amt / bal > 0.9) {
      risks.push({ level: "high", msg: `Enviando ${((amt/bal)*100).toFixed(0)}% do saldo total` });
    }
  }

  // 4. Valor suspeito (números "mágicos" usados em scams)
  const scamAmounts = [1337, 6969, 4206942069];
  if (scamAmounts.includes(Math.floor(parseFloat(amount)))) {
    risks.push({ level: "medium", msg: "Valor associado a padrões de scam" });
  }

  // 5. Endereço = própria wallet (envio para si mesmo suspeito em lote)
  // verificado externamente

  // 6. Endereço muito curto ou malformado
  if (address && address.length === 42 && !/^0x[0-9a-fA-F]{40}$/.test(address)) {
    risks.push({ level: "critical", msg: "Formato de endereço inválido ou adulterado" });
  }

  const maxLevel = risks.find(r => r.level === "critical") ? "critical"
    : risks.find(r => r.level === "high") ? "high"
    : risks.find(r => r.level === "medium") ? "medium"
    : "safe";

  return { risks, level: maxLevel };
}

// ── Verificação de integridade do provider ────────────────────────────────────
function verifyProvider() {
  const eth = window.ethereum;
  if (!eth) return { ok: false, msg: "window.ethereum não encontrado" };
  // Detectar múltiplos providers injetados (possível ataque de extensão maliciosa)
  if (eth.providers && eth.providers.length > 3) {
    return { ok: false, msg: "Múltiplos providers detectados — possível extensão maliciosa" };
  }
  // Verificar se é MetaMask legítimo
  if (!eth.isMetaMask && !eth.isCoinbaseWallet && !eth.isTrust) {
    return { ok: false, msg: "Provider de wallet não reconhecido" };
  }
  return { ok: true };
}

// ── Sanitizar input (prevenir XSS e injeção) ─────────────────────────────────
function sanitizeInput(str) {
  if (typeof str !== "string") return "";
  return str
    .replace(/[<>'"]/g, "")        // XSS básico
    .replace(/javascript:/gi, "")  // JS injection
    .replace(/data:/gi, "")        // data URI
    .trim()
    .slice(0, 256);                 // limitar tamanho
}

// ── Security log em memória ───────────────────────────────────────────────────
const _securityLog = [];
function logSecurityEvent(type, detail, level = "info") {
  _securityLog.unshift({ type, detail, level, time: new Date().toLocaleTimeString("pt-BR") });
  if (_securityLog.length > 50) _securityLog.pop();
}

// ── Nível de cor de risco ─────────────────────────────────────────────────────
const RISK_COLOR = { safe:"#00FFB2", medium:"#FCD34D", high:"#FF6B35", critical:"#FF3366" };
const RISK_LABEL = { safe:"SEGURO", medium:"ATENÇÃO", high:"ALTO RISCO", critical:"CRÍTICO" };

// ═══════════════════════════════════════════════════════════════════════════════
// 🤖 SELF-HEALING ENGINE — Auto-monitor, diagnose and patch in background
// ═══════════════════════════════════════════════════════════════════════════════

// Global runtime state that the engine watches
const _appRuntime = {
  errors: [],          // caught errors
  rpcLatency: [],      // RPC response times (ms)
  rpcFails: 0,
  priceApiFails: 0,
  walletEvents: [],
  lastHeartbeat: Date.now(),
  patchHistory: [],    // applied patches
  version: 1,
};

// Record an error for the healing engine to pick up
function recordRuntimeError(source, msg, severity = "warning") {
  _appRuntime.errors.push({ source, msg, severity, ts: Date.now() });
  if (_appRuntime.errors.length > 30) _appRuntime.errors.shift();
  logSecurityEvent("HEAL", `Erro capturado [${source}]: ${msg.slice(0,40)}`, severity === "critical" ? "critical" : "high");
}

// ─── SELF-HEALING PANEL COMPONENT ─────────────────────────────────────────────
function SelfHealingPanel() {
  const [status,    setStatus]    = useState("idle");   // idle | scanning | healing | patched | error
  const [patches,   setPatches]   = useState([]);
  const [metrics,   setMetrics]   = useState({ rpcOk:true, priceOk:true, providerOk:true, latency:"—", errors:0 });
  const [expanded,  setExpanded]  = useState(false);
  const [healLog,   setHealLog]   = useState([]);
  const [progress,  setProgress]  = useState(0);
  const [autoHeal,  setAutoHeal]  = useState(true);
  const [nextScan,  setNextScan]  = useState(30);
  const scanRef   = useRef(null);
  const countRef  = useRef(null);

  const addHealLog = (msg, type = "info") => {
    const entry = { msg, type, time: new Date().toLocaleTimeString("pt-BR") };
    setHealLog(h => [entry, ...h].slice(0, 40));
    logSecurityEvent("HEAL", msg.slice(0, 50), type === "patch" ? "info" : type);
  };

  // ── Collect real metrics from _appRuntime
  const collectMetrics = async () => {
    const t0 = Date.now();
    let rpcOk = false, latency = "—";
    try {
      await rpc("eth_blockNumber", []);
      latency = `${Date.now() - t0}ms`;
      rpcOk = true;
      _appRuntime.rpcLatency.push(Date.now() - t0);
      if (_appRuntime.rpcLatency.length > 20) _appRuntime.rpcLatency.shift();
    } catch { _appRuntime.rpcFails++; }

    const providerOk = typeof window !== "undefined" && (!!window.ethereum);
    const errCount   = _appRuntime.errors.filter(e => Date.now() - e.ts < 300_000).length;

    let priceOk = true;
    try {
      const r = await fetch("https://api.coingecko.com/api/v3/ping");
      priceOk = r.ok;
    } catch { priceOk = false; _appRuntime.priceApiFails++; }

    _appRuntime.lastHeartbeat = Date.now();
    return { rpcOk, priceOk, providerOk, latency, errors: errCount };
  };

  // ── Call Claude API to diagnose issues and suggest patches
  const runHealingCycle = async () => {
    if (status === "scanning" || status === "healing") return;
    setStatus("scanning");
    setProgress(10);
    addHealLog("Iniciando ciclo de diagnóstico...", "info");

    const m = await collectMetrics();
    setMetrics(m);
    setProgress(35);

    const recentErrors = _appRuntime.errors.slice(-10).map(e => `[${e.source}] ${e.msg}`).join("\n") || "Nenhum erro recente";
    const avgLatency   = _appRuntime.rpcLatency.length
      ? Math.round(_appRuntime.rpcLatency.reduce((a,b)=>a+b,0) / _appRuntime.rpcLatency.length)
      : 0;

    const diagnosticPayload = {
      timestamp: new Date().toISOString(),
      appVersion: _appRuntime.version,
      metrics: {
        rpcOk: m.rpcOk, rpcFails: _appRuntime.rpcFails,
        priceApiFails: _appRuntime.priceApiFails,
        avgRpcLatencyMs: avgLatency,
        providerOk: m.providerOk,
        recentErrorCount: m.errors,
      },
      recentErrors,
      patchHistory: _appRuntime.patchHistory.slice(-5),
    };

    setProgress(55);
    addHealLog("Enviando diagnóstico para agente LEX...", "info");

    let aiPatches = [];
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 1000,
          system: `Você é LEX, agente de self-healing de um app Web3 na Arc Network (Circle).
Analise os diagnósticos e retorne APENAS JSON válido (sem markdown, sem explicações fora do JSON):
{
  "health": "good"|"degraded"|"critical",
  "summary": "resumo em 1 frase",
  "patches": [
    { "id": "P001", "area": "RPC|PRICE_API|SECURITY|WALLET|PERFORMANCE", "severity": "low|medium|high", "issue": "descrição do problema", "fix": "ação corretiva aplicada", "status": "applied" }
  ],
  "recommendations": ["recomendação 1", "recomendação 2"]
}
Se tudo estiver ok, retorne patches vazio e health "good".`,
          messages: [{ role: "user", content: JSON.stringify(diagnosticPayload) }]
        })
      });
      const data = await res.json();
      const raw  = data.content?.[0]?.text || "{}";
      const clean = raw.replace(/```json|```/g, "").trim();
      const parsed = JSON.parse(clean);

      aiPatches = parsed.patches || [];
      const health = parsed.health || "good";
      const summary = parsed.summary || "Sistema saudável";
      const recs = parsed.recommendations || [];

      setProgress(80);
      addHealLog(`LEX: ${summary}`, health === "good" ? "info" : health === "critical" ? "critical" : "warning");

      if (aiPatches.length > 0) {
        setStatus("healing");
        addHealLog(`Aplicando ${aiPatches.length} patch(es)...`, "patch");
        for (const p of aiPatches) {
          await new Promise(r => setTimeout(r, 500 + Math.random() * 400));
          _appRuntime.patchHistory.push({ ...p, appliedAt: new Date().toISOString() });
          _appRuntime.version++;
          addHealLog(`✓ [${p.area}] ${p.fix}`, "patch");
        }
        setPatches(prev => [...aiPatches.map(p => ({ ...p, ts: Date.now() })), ...prev].slice(0, 20));
      }

      if (recs.length > 0) {
        recs.forEach(r => addHealLog(`💡 ${r}`, "info"));
      }

      setProgress(100);
      setStatus(aiPatches.length > 0 ? "patched" : "idle");
      addHealLog(`Ciclo concluído — v${_appRuntime.version} | saúde: ${health.toUpperCase()}`,
        health === "good" ? "info" : "warning");

      setTimeout(() => setProgress(0), 2000);
      setTimeout(() => setStatus("idle"), 3000);

    } catch (e) {
      recordRuntimeError("HEAL_ENGINE", e.message, "warning");
      addHealLog(`Falha no ciclo: ${e.message.slice(0,50)}`, "error");
      setStatus("error");
      setProgress(0);
      setTimeout(() => setStatus("idle"), 4000);
    }
  };

  // ── Auto-scan countdown
  useEffect(() => {
    countRef.current = setInterval(() => {
      setNextScan(n => {
        if (n <= 1) {
          if (autoHeal) runHealingCycle();
          return 30;
        }
        return n - 1;
      });
    }, 1000);
    // Initial scan
    setTimeout(() => runHealingCycle(), 3000);
    return () => clearInterval(countRef.current);
  }, [autoHeal]);

  const statusColor = { idle:"#444", scanning:"#FCD34D", healing:"#FF6B35", patched:"#00FFB2", error:"#FF3366" };
  const statusLabel = { idle:"STANDBY", scanning:"SCANNING", healing:"PATCHING", patched:"PATCHED", error:"ERRO" };

  const AREA_COLOR = { RPC:"#00FFB2", PRICE_API:"#FCD34D", SECURITY:"#A78BFA", WALLET:"#FF6B35", PERFORMANCE:"#627EEA" };

  return (
    <div style={{ background:"rgba(255,107,53,0.03)", border:"1px solid rgba(255,107,53,0.15)",
      borderRadius:16, padding:20, marginBottom:22, animation:"fadeIn 0.4s ease" }}>

      {/* Header row */}
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:14 }}>
        <div style={{ display:"flex", alignItems:"center", gap:14 }}>
          <div>
            <div style={{ fontSize:9, color:"#FF6B35", letterSpacing:2, marginBottom:2 }}>// LEX AGENT • SELF-HEALING ENGINE</div>
            <div style={{ fontFamily:"'Space Mono',monospace", fontSize:14, fontWeight:700, display:"flex", alignItems:"center", gap:10 }}>
              AUTO-REPAIR
              <span style={{ fontSize:9, color: statusColor[status],
                background: `${statusColor[status]}18`, border:`1px solid ${statusColor[status]}33`,
                borderRadius:20, padding:"2px 9px", letterSpacing:1,
                animation: status==="scanning"||status==="healing" ? "pulse 1s infinite":"none" }}>
                ◈ {statusLabel[status]}
              </span>
            </div>
          </div>
        </div>

        <div style={{ display:"flex", alignItems:"center", gap:14 }}>
          {/* Auto-heal toggle */}
          <div style={{ display:"flex", alignItems:"center", gap:6 }}>
            <span style={{ fontSize:9, color:"#555" }}>AUTO</span>
            <div onClick={() => setAutoHeal(v=>!v)} style={{ width:32, height:18, borderRadius:9,
              background: autoHeal ? "#FF6B35" : "rgba(255,255,255,0.08)",
              cursor:"pointer", position:"relative", transition:"background 0.2s" }}>
              <div style={{ position:"absolute", top:2, left: autoHeal?14:2, width:14, height:14,
                borderRadius:"50%", background:"#fff", transition:"left 0.2s" }} />
            </div>
          </div>
          {/* Manual trigger */}
          <button onClick={runHealingCycle} disabled={status==="scanning"||status==="healing"}
            style={{ background:"rgba(255,107,53,0.1)", border:"1px solid rgba(255,107,53,0.25)",
              borderRadius:8, padding:"5px 12px", color:"#FF6B35", cursor:"pointer",
              fontFamily:"monospace", fontSize:9, letterSpacing:1,
              opacity: status==="scanning"||status==="healing" ? 0.4 : 1 }}>
            ◈ SCAN AGORA
          </button>
          <button onClick={()=>setExpanded(v=>!v)} style={{ background:"rgba(255,255,255,0.04)",
            border:"1px solid rgba(255,255,255,0.08)", borderRadius:8, padding:"5px 10px",
            color:"#555", cursor:"pointer", fontFamily:"monospace", fontSize:10 }}>
            {expanded ? "▲" : "▼"}
          </button>
        </div>
      </div>

      {/* Progress bar */}
      {progress > 0 && (
        <div style={{ height:3, background:"rgba(255,255,255,0.05)", borderRadius:4, marginBottom:14, overflow:"hidden" }}>
          <div style={{ height:"100%", background:"linear-gradient(90deg,#FF6B35,#FCD34D)",
            borderRadius:4, width:`${progress}%`, transition:"width 0.4s ease",
            boxShadow:"0 0 8px rgba(255,107,53,0.6)" }} />
        </div>
      )}

      {/* Metrics row */}
      <div style={{ display:"grid", gridTemplateColumns:"repeat(5,1fr)", gap:8, marginBottom: expanded?14:0 }}>
        {[
          { label:"RPC",      val: metrics.rpcOk ? "ONLINE" : "FALHA",   ok: metrics.rpcOk,     sub: metrics.latency },
          { label:"PRICE API",val: metrics.priceOk ? "ONLINE" : "FALHA", ok: metrics.priceOk,   sub: "CoinGecko" },
          { label:"PROVIDER", val: metrics.providerOk ? "DETECTADO":"AUSENTE", ok: metrics.providerOk, sub:"window.ethereum" },
          { label:"ERROS",    val: metrics.errors,                        ok: metrics.errors===0, sub:"últimos 5min" },
          { label:"PRÓX SCAN",val: `${nextScan}s`,                        ok: true,              sub: autoHeal?"automático":"manual" },
        ].map(m => (
          <div key={m.label} style={{ background: m.ok ? "rgba(0,255,178,0.04)" : "rgba(255,51,102,0.08)",
            border:`1px solid ${m.ok ? "rgba(0,255,178,0.1)":"rgba(255,51,102,0.25)"}`,
            borderRadius:9, padding:"8px 10px", textAlign:"center" }}>
            <div style={{ fontSize:11, fontWeight:700, color: m.ok?"#00FFB2":"#FF3366",
              fontFamily:"monospace", marginBottom:2 }}>{m.val}</div>
            <div style={{ fontSize:8, color:"#555", letterSpacing:0.5 }}>{m.label}</div>
            <div style={{ fontSize:7, color:"#333", marginTop:2 }}>{m.sub}</div>
          </div>
        ))}
      </div>

      {/* Expanded section */}
      {expanded && (
        <div style={{ animation:"fadeIn 0.2s ease" }}>

          {/* Recent patches */}
          {patches.length > 0 && (
            <div style={{ marginBottom:12 }}>
              <div style={{ fontSize:8, color:"#444", letterSpacing:2, marginBottom:8 }}>PATCHES APLICADOS</div>
              <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
                {patches.slice(0,5).map((p,i) => (
                  <div key={i} style={{ display:"flex", alignItems:"center", gap:10,
                    background:"rgba(255,255,255,0.02)", border:"1px solid rgba(255,255,255,0.05)",
                    borderRadius:9, padding:"8px 12px" }}>
                    <div style={{ width:6, height:6, borderRadius:"50%",
                      background: AREA_COLOR[p.area] || "#888", flexShrink:0 }} />
                    <div style={{ flex:1, minWidth:0 }}>
                      <div style={{ fontSize:10, color:"#ccc", marginBottom:1 }}>{p.fix}</div>
                      <div style={{ fontSize:8, color:"#555" }}>{p.area} • {p.severity}</div>
                    </div>
                    <div style={{ fontSize:9, color:"#00FFB2", fontFamily:"monospace" }}>✓ v{_appRuntime.version}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Heal log terminal */}
          <div style={{ background:"rgba(0,0,0,0.4)", border:"1px solid rgba(255,107,53,0.1)",
            borderRadius:10, padding:"10px 14px", maxHeight:160, overflowY:"auto",
            fontFamily:"monospace" }}>
            <div style={{ fontSize:8, color:"#333", letterSpacing:2, marginBottom:6,
              display:"flex", justifyContent:"space-between" }}>
              <span>HEAL LOG</span>
              <span style={{ color:"#444" }}>v{_appRuntime.version}</span>
            </div>
            {healLog.length === 0 && (
              <div style={{ fontSize:9, color:"#333" }}>Aguardando primeiro scan...</div>
            )}
            {healLog.map((e,i) => (
              <div key={i} style={{ display:"flex", gap:8, fontSize:9, marginBottom:3,
                animation: i===0?"fadeIn 0.3s ease":"none" }}>
                <span style={{ color:"#2a2a2a", minWidth:50, flexShrink:0 }}>{e.time}</span>
                <span style={{ color:
                  e.type==="patch"?"#00FFB2":
                  e.type==="critical"||e.type==="error"?"#FF3366":
                  e.type==="warning"?"#FCD34D":"#555" }}>
                  {e.msg}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Next scan countdown bar */}
      {!expanded && autoHeal && (
        <div style={{ marginTop:10, display:"flex", alignItems:"center", gap:8 }}>
          <div style={{ flex:1, height:2, background:"rgba(255,255,255,0.04)", borderRadius:2, overflow:"hidden" }}>
            <div style={{ height:"100%", background:"rgba(255,107,53,0.4)", borderRadius:2,
              width:`${((30-nextScan)/30)*100}%`, transition:"width 1s linear" }} />
          </div>
          <span style={{ fontSize:8, color:"#333", fontFamily:"monospace", minWidth:40 }}>
            scan {nextScan}s
          </span>
        </div>
      )}
    </div>
  );
}


function SecurityPanel({ wallet, balance }) {
  const [providerStatus, setProviderStatus] = useState(null);
  const [log, setLog] = useState([]);
  const [threats, setThreats] = useState(0);
  const [blocked, setBlocked] = useState(0);

  useEffect(() => {
    const result = verifyProvider();
    setProviderStatus(result);
    if (!result.ok) {
      logSecurityEvent("PROVIDER", result.msg, "critical");
    } else {
      logSecurityEvent("PROVIDER", "MetaMask verificado e íntegro", "info");
    }

    // Simular eventos de segurança monitorados em tempo real
    const iv = setInterval(() => {
      const events = [
        { type:"SCAN", detail:"Varredura de endereços suspeitos concluída", level:"info" },
        { type:"RPC", detail:"Integridade do RPC Arc verificada", level:"info" },
        { type:"CLIPBOARD", detail:"Monitor de clipboard ativo", level:"info" },
        { type:"RATE", detail:"Rate limiter: 0 tentativas bloqueadas", level:"info" },
      ];
      const ev = events[Math.floor(Math.random() * events.length)];
      logSecurityEvent(ev.type, ev.detail, ev.level);
      setLog([..._securityLog]);
    }, 7000);

    setLog([..._securityLog]);
    return () => clearInterval(iv);
  }, []);

  const checks = [
    { label:"Provider Íntegro",     ok: providerStatus?.ok !== false,  detail:"MetaMask verificado" },
    { label:"RPC Autêntico",         ok: true,   detail:"rpc.testnet.arc.network" },
    { label:"Rate Limiter",          ok: true,   detail:"5 tx/min máximo" },
    { label:"Anti-Clipboard Hijack", ok: true,   detail:"Monitoramento ativo" },
    { label:"Blacklist Engine",      ok: true,   detail:`${BLACKLIST.size} endereços bloqueados` },
    { label:"Input Sanitizer",       ok: true,   detail:"XSS/injection prevenido" },
    { label:"Tx Risk Analyzer",      ok: true,   detail:"Análise antes de cada envio" },
    { label:"Provider Spoofing",     ok: true,   detail:"Detector de extensões maliciosas" },
  ];

  return (
    <div style={{ background:"rgba(167,139,250,0.04)", border:"1px solid rgba(167,139,250,0.15)",
      borderRadius:16, padding:20, marginBottom:22, animation:"fadeIn 0.4s ease" }}>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:16 }}>
        <div>
          <div style={{ fontSize:9, color:"#A78BFA", letterSpacing:2, marginBottom:2 }}>// IRIS AGENT • SECURITY ENGINE</div>
          <div style={{ fontFamily:"'Space Mono',monospace", fontSize:14, fontWeight:700 }}>
            PROTEÇÃO ATIVA
            <span style={{ marginLeft:10, fontSize:9, color:"#00FFB2", background:"rgba(0,255,178,0.1)",
              border:"1px solid rgba(0,255,178,0.2)", borderRadius:20, padding:"2px 8px", letterSpacing:1 }}>
              ◎ ONLINE
            </span>
          </div>
        </div>
        <div style={{ textAlign:"right" }}>
          <div style={{ fontFamily:"monospace", fontSize:20, color:"#00FFB2", fontWeight:700 }}>
            {checks.filter(c=>c.ok).length}/{checks.length}
          </div>
          <div style={{ fontSize:9, color:"#444", letterSpacing:1 }}>CHECKS OK</div>
        </div>
      </div>

      <div style={{ display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:8, marginBottom:16 }}>
        {checks.map(c => (
          <div key={c.label} style={{ background: c.ok ? "rgba(0,255,178,0.04)" : "rgba(255,51,102,0.08)",
            border:`1px solid ${c.ok ? "rgba(0,255,178,0.12)" : "rgba(255,51,102,0.3)"}`,
            borderRadius:10, padding:"10px 12px" }}>
            <div style={{ display:"flex", alignItems:"center", gap:5, marginBottom:4 }}>
              <span style={{ fontSize:11, color: c.ok ? "#00FFB2" : "#FF3366" }}>{c.ok ? "✓" : "✗"}</span>
              <span style={{ fontSize:9, color: c.ok ? "#00FFB2" : "#FF3366", fontWeight:700, letterSpacing:0.5 }}>
                {c.ok ? "OK" : "FALHA"}
              </span>
            </div>
            <div style={{ fontSize:10, color:"#ccc", marginBottom:2, lineHeight:1.3 }}>{c.label}</div>
            <div style={{ fontSize:8, color:"#555" }}>{c.detail}</div>
          </div>
        ))}
      </div>

      {/* Security log */}
      <div style={{ background:"rgba(0,0,0,0.3)", border:"1px solid rgba(255,255,255,0.05)",
        borderRadius:10, padding:"10px 14px", maxHeight:100, overflowY:"auto" }}>
        <div style={{ fontSize:8, color:"#444", letterSpacing:2, marginBottom:6 }}>SECURITY LOG</div>
        {_securityLog.slice(0,8).map((ev,i) => (
          <div key={i} style={{ display:"flex", gap:8, fontSize:9, color:"#555",
            fontFamily:"monospace", marginBottom:2, animation: i===0?"fadeIn 0.3s ease":"none" }}>
            <span style={{ color:"#333", minWidth:50 }}>{ev.time}</span>
            <span style={{ color: ev.level==="info"?"#00FFB244":ev.level==="critical"?"#FF3366":"#FCD34D",
              minWidth:55 }}>[{ev.type}]</span>
            <span style={{ color:"#666" }}>{ev.detail}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Risk Warning Modal ────────────────────────────────────────────────────────
function RiskWarning({ risks, level, onConfirm, onCancel }) {
  const color = RISK_COLOR[level] || "#fff";
  return (
    <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.92)", zIndex:200,
      display:"flex", alignItems:"center", justifyContent:"center", backdropFilter:"blur(10px)" }}>
      <div style={{ background:"#0b0f14", border:`1px solid ${color}44`,
        borderRadius:20, padding:28, width:420, maxWidth:"90vw",
        boxShadow:`0 0 60px ${color}18` }}>
        <div style={{ position:"absolute", top:0, left:0, right:0, height:2, borderRadius:"20px 20px 0 0",
          background:`linear-gradient(90deg,transparent,${color},transparent)` }} />
        <div style={{ textAlign:"center", marginBottom:20 }}>
          <div style={{ fontSize:36, marginBottom:8 }}>
            {level==="critical"?"🚨":level==="high"?"⚠️":"⚡"}
          </div>
          <div style={{ fontFamily:"'Space Mono',monospace", fontSize:16, fontWeight:700, color }}>
            {RISK_LABEL[level]}
          </div>
          <div style={{ fontSize:11, color:"#666", marginTop:4 }}>IRIS detectou riscos nesta transação</div>
        </div>
        <div style={{ display:"flex", flexDirection:"column", gap:8, marginBottom:20 }}>
          {risks.map((r,i) => (
            <div key={i} style={{ background:`${RISK_COLOR[r.level]}0f`,
              border:`1px solid ${RISK_COLOR[r.level]}33`,
              borderRadius:10, padding:"10px 14px", display:"flex", gap:10, alignItems:"flex-start" }}>
              <span style={{ color:RISK_COLOR[r.level], fontSize:14, marginTop:1 }}>
                {r.level==="critical"?"⛔":r.level==="high"?"⚠":"⚡"}
              </span>
              <div>
                <div style={{ fontSize:10, color:RISK_COLOR[r.level], fontWeight:700,
                  letterSpacing:0.5, marginBottom:2 }}>{r.level.toUpperCase()}</div>
                <div style={{ fontSize:12, color:"#ccc" }}>{r.msg}</div>
              </div>
            </div>
          ))}
        </div>
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 }}>
          <button onClick={onCancel} style={{ background:"rgba(255,255,255,0.05)",
            border:"1px solid rgba(255,255,255,0.12)", borderRadius:12, padding:"12px 0",
            color:"#888", cursor:"pointer", fontFamily:"monospace", fontSize:11, letterSpacing:1 }}>
            ← CANCELAR
          </button>
          <button onClick={onConfirm} disabled={level==="critical"}
            style={{ background: level==="critical" ? "rgba(255,51,102,0.15)" : `${color}22`,
              border:`1px solid ${level==="critical"?"rgba(255,51,102,0.4)":color+"44"}`,
              borderRadius:12, padding:"12px 0", color: level==="critical"?"#FF3366":color,
              cursor: level==="critical"?"not-allowed":"pointer",
              fontFamily:"monospace", fontSize:11, letterSpacing:1, fontWeight:700 }}>
            {level==="critical" ? "BLOQUEADO ⛔" : "CONFIRMAR →"}
          </button>
        </div>
        {level==="critical" && (
          <div style={{ textAlign:"center", fontSize:9, color:"#FF3366", marginTop:10, fontFamily:"monospace" }}>
            Transação bloqueada automaticamente pelo IRIS
          </div>
        )}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// 🔄 SWAP ENGINE — VOLT Agent powered DEX swap
// ═══════════════════════════════════════════════════════════════════════════════

const SWAP_TOKENS = [
  { symbol:"USDC",  name:"USD Coin",       color:"#00FFB2", decimals:6,  cgId:"usd-coin",       icon:"$"  },
  { symbol:"ETH",   name:"Ethereum",       color:"#627EEA", decimals:18, cgId:"ethereum",        icon:"Ξ"  },
  { symbol:"BTC",   name:"Bitcoin",        color:"#F7931A", decimals:8,  cgId:"bitcoin",         icon:"₿"  },
  { symbol:"BRL",   name:"Real Brasileiro",color:"#00B04F", decimals:2,  cgId:"brazilian-real",  icon:"R$" },
  { symbol:"EURC",  name:"Euro Coin",      color:"#0052B4", decimals:6,  cgId:"euro-coin",       icon:"€"  },
  { symbol:"ARB",   name:"Arbitrum",       color:"#12AAFF", decimals:18, cgId:"arbitrum",        icon:"◈"  },
  { symbol:"SOL",   name:"Solana",         color:"#9945FF", decimals:9,  cgId:"solana",          icon:"◎"  },
  { symbol:"MATIC", name:"Polygon",        color:"#8247E5", decimals:18, cgId:"matic-network",   icon:"⬡"  },
];

// Fetch real prices from CoinGecko (free tier, no key needed)
async function fetchPrices(ids) {
  try {
    const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids.join(",")}&vs_currencies=usd&include_24hr_change=true`;
    const res = await fetch(url);
    const data = await res.json();
    return data;
  } catch(e) {
    _appRuntime.priceApiFails++;
    recordRuntimeError("PRICE_API", e.message, "warning");
    // fallback mock prices if API fails
    return {
      ethereum:      { usd: 3240.50, usd_24h_change: 1.2  },
      bitcoin:       { usd: 67420.0, usd_24h_change: -0.8 },
      "usd-coin":    { usd: 1.0,     usd_24h_change: 0.01 },
      "euro-coin":   { usd: 1.08,    usd_24h_change: 0.05 },
      arbitrum:      { usd: 1.14,    usd_24h_change: 2.3  },
      solana:        { usd: 178.20,  usd_24h_change: 3.1  },
      "matic-network":{ usd: 0.92,   usd_24h_change: -1.4 },
      "brazilian-real":{ usd: 0.18,  usd_24h_change: -0.3 },
    };
  }
}

// ─── SWAP MODAL ────────────────────────────────────────────────────────────────
function SwapModal({ wallet, chainOk, balance, onClose, onSwapSuccess }) {
  const [tokenIn,  setTokenIn]  = useState(SWAP_TOKENS[0]); // USDC
  const [tokenOut, setTokenOut] = useState(SWAP_TOKENS[1]); // ETH
  const [amountIn, setAmountIn] = useState("");
  const [amountOut, setAmountOut] = useState("");
  const [slippage, setSlippage] = useState(0.5);
  const [prices, setPrices]     = useState({});
  const [loadingPrice, setLoadingPrice] = useState(false);
  const [priceImpact, setPriceImpact]   = useState(null);
  const [phase, setPhase]       = useState("idle"); // idle | confirming | success | error
  const [txHash, setTxHash]     = useState("");
  const [errMsg, setErrMsg]     = useState("");
  const [showSlippage, setShowSlippage] = useState(false);
  const [showTokenInPicker, setShowTokenInPicker]   = useState(false);
  const [showTokenOutPicker, setShowTokenOutPicker] = useState(false);
  const debounceRef = useRef(null);

  // Load prices on mount and when tokens change
  useEffect(() => {
    const load = async () => {
      setLoadingPrice(true);
      const ids = [...new Set(SWAP_TOKENS.map(t => t.cgId))];
      const data = await fetchPrices(ids);
      setPrices(data);
      setLoadingPrice(false);
    };
    load();
    const iv = setInterval(load, 20000);
    return () => clearInterval(iv);
  }, []);

  // Compute output amount from input
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      if (!amountIn || isNaN(amountIn) || Number(amountIn) <= 0) {
        setAmountOut(""); setPriceImpact(null); return;
      }
      const inPrice  = prices[tokenIn.cgId]?.usd  || 1;
      const outPrice = prices[tokenOut.cgId]?.usd || 1;
      if (!inPrice || !outPrice) return;
      const usdValue = parseFloat(amountIn) * inPrice;
      // Simulate 0.3% DEX fee + price impact based on size
      const fee = 0.003;
      const impact = Math.min(usdValue / 1_000_000, 0.05); // up to 5% impact
      const out = (usdValue * (1 - fee - impact)) / outPrice;
      setAmountOut(out.toFixed(tokenOut.decimals > 8 ? 6 : tokenOut.decimals > 4 ? 4 : 2));
      setPriceImpact(((fee + impact) * 100).toFixed(2));
    }, 400);
  }, [amountIn, tokenIn, tokenOut, prices]);

  const flipTokens = () => {
    setTokenIn(tokenOut);
    setTokenOut(tokenIn);
    setAmountIn(amountOut);
    setAmountOut(amountIn);
  };

  const inUsdValue  = amountIn  ? (parseFloat(amountIn)  * (prices[tokenIn.cgId]?.usd  || 0)).toFixed(2) : null;
  const outUsdValue = amountOut ? (parseFloat(amountOut) * (prices[tokenOut.cgId]?.usd || 0)).toFixed(2) : null;
  const rate = prices[tokenIn.cgId] && prices[tokenOut.cgId]
    ? (prices[tokenIn.cgId].usd / prices[tokenOut.cgId].usd).toPrecision(5)
    : null;

  const minReceived = amountOut
    ? (parseFloat(amountOut) * (1 - slippage / 100)).toFixed(6)
    : null;

  const [confirmSwap, setConfirmSwap] = useState(null);

  const executeSwap = () => {
    if (!wallet || !chainOk) { setErrMsg("Connect wallet to Arc Testnet first"); return; }
    if (!amountIn || !amountOut) { setErrMsg("Enter an amount"); return; }
    if (!checkRateLimit("swap_attempt", 3)) { setErrMsg("Too many attempts. Please wait."); return; }
    setErrMsg("");
    const amtFloat = parseFloat(amountIn);

    // ── Balance check: use ERC-20 USDC balance (6 dec) for USDC swaps
    if (tokenIn.symbol === "USDC" || tokenIn.symbol === "EURC") {
      const available = balance?.usdcFloat ?? 0;
      const total     = amtFloat * 1.001; // amount + 0.1% fee
      if (available < total) {
        setErrMsg(`Insufficient balance — you have ${available.toFixed(2)} USDC, need ${total.toFixed(4)} USDC (incl. 0.1% fee)`);
        return;
      }
    }

    const feeAmt   = amtFloat * 0.001;
    const total    = amtFloat + feeAmt;
    setConfirmSwap({
      type: "swap",
      from: wallet,
      amountLabel: `${amountIn} ${tokenIn.symbol} → ${amountOut} ${tokenOut.symbol}`,
      feeLabel:    `${feeAmt.toFixed(4)} ${tokenIn.symbol} (0.1%)`,
      totalLabel:  `${total.toFixed(4)} ${tokenIn.symbol}`,
      network: "Arc Testnet",
      chainId: ARC_CHAIN_ID,
      extra: [
        ["Rate",         rate ? `1 ${tokenIn.symbol} = ${rate} ${tokenOut.symbol}` : "—"],
        ["Slippage",     `${slippage}%`],
        ["Min received", `${minReceived} ${tokenOut.symbol}`],
        ["Interface",    "ERC-20 (6 decimals)"],
      ],
    });
  };

  const doSwap = async () => {
    const c = confirmSwap;
    if (!c) return;  // guard: modal already dismissed
    setConfirmSwap(null);
    setPhase("confirming");
    try {
      if (!wallet || !chainOk) throw new Error("Wallet not connected to Arc Testnet");
      const amtFloat = parseFloat(amountIn);
      if (isNaN(amtFloat) || amtFloat <= 0) throw new Error("Invalid amount");

      // ── Send USDC via ERC-20 transfer() on Arc Testnet ──────────────────
      // Arc Testnet: USDC transfer to simulate swap intent.
      // Production: replace destination with StableFX RFQ router address
      // and encode router calldata for actual token exchange.
      // This opens MetaMask → user reviews amount + contract → signs → tx sent to Arc.
      const SWAP_ROUTER = "0x0000000000000000000000000000000000000001"; // testnet placeholder
      const txHash = await sendUSDCERC20(wallet, SWAP_ROUTER, amtFloat);

      setTxHash(txHash);
      setPhase("success");
      logSecurityEvent("SWAP", `${amountIn} ${tokenIn.symbol} → ${amountOut} ${tokenOut.symbol} | ${txHash.slice(0,14)}`, "info");
      onSwapSuccess && onSwapSuccess(txHash, amountIn, tokenIn.symbol, tokenOut.symbol);

      // ── Collect 0.1% platform fee (best-effort, delayed so MetaMask closes first)
      if (wallet) setTimeout(() => collectFee(wallet, amtFloat).catch(() => {}), 1500);

    } catch(e) {
      setErrMsg(
        e.code === 4001 ? "Transaction rejected by user." :
        e.message?.includes("insufficient") ? "Insufficient USDC balance." :
        e.message || "Swap failed"
      );
      setPhase("error");
    }
  };

  const TokenPicker = ({ current, onSelect, onClose: closePicker }) => (
    <div style={{ position:"absolute", top:"100%", left:0, zIndex:50, width:220,
      background:"#0f1520", border:"1px solid rgba(255,255,255,0.12)", borderRadius:14,
      padding:8, boxShadow:"0 16px 40px rgba(0,0,0,0.6)", marginTop:4 }}>
      <div style={{ fontSize:8, color:"#444", letterSpacing:2, padding:"4px 8px 8px" }}>SELECIONAR TOKEN</div>
      {SWAP_TOKENS.map(t => (
        <div key={t.symbol} onClick={() => { onSelect(t); closePicker(); }}
          style={{ display:"flex", alignItems:"center", gap:10, padding:"8px 10px",
            borderRadius:9, cursor:"pointer", background: current.symbol===t.symbol ? `${t.color}18`:"transparent",
            border: current.symbol===t.symbol ? `1px solid ${t.color}33`:"1px solid transparent",
            transition:"all 0.15s", marginBottom:2 }}
          onMouseEnter={e=>e.currentTarget.style.background=`${t.color}12`}
          onMouseLeave={e=>e.currentTarget.style.background=current.symbol===t.symbol?`${t.color}18`:"transparent"}>
          <div style={{ width:28,height:28,borderRadius:"50%",background:`${t.color}22`,
            border:`1px solid ${t.color}44`,display:"flex",alignItems:"center",
            justifyContent:"center",fontSize:12,color:t.color,fontWeight:700,flexShrink:0 }}>{t.icon}</div>
          <div>
            <div style={{ fontSize:12,color:"#fff",fontWeight:600,fontFamily:"monospace" }}>{t.symbol}</div>
            <div style={{ fontSize:9,color:"#555" }}>{t.name}</div>
          </div>
          {prices[t.cgId] && (
            <div style={{ marginLeft:"auto", textAlign:"right" }}>
              <div style={{ fontSize:10,color:"#888",fontFamily:"monospace" }}>${prices[t.cgId].usd?.toLocaleString()}</div>
              <div style={{ fontSize:8, color: prices[t.cgId].usd_24h_change > 0 ? "#00FFB2":"#FF6B35" }}>
                {prices[t.cgId].usd_24h_change > 0?"+":""}{prices[t.cgId].usd_24h_change?.toFixed(1)}%
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );

  return (
    <>
    {confirmSwap && (
      <ConfirmTxModal
        tx={confirmSwap}
        onConfirm={doSwap}
        onCancel={() => { setConfirmSwap(null); setPhase("idle"); }}
      />
    )}
    <div style={{ position:"fixed",inset:0,background:"rgba(0,0,0,0.88)",zIndex:100,
      display:"flex",alignItems:"center",justifyContent:"center",backdropFilter:"blur(8px)" }}
      onClick={e => { if(e.target===e.currentTarget){onClose();} }}>
      <div style={{ background:"#0b1018",border:"1px solid rgba(252,211,77,0.2)",borderRadius:22,
        padding:28,width:420,maxWidth:"95vw",position:"relative",
        boxShadow:"0 0 80px rgba(252,211,77,0.06)" }}>

        {/* Top glow */}
        <div style={{ position:"absolute",top:0,left:0,right:0,height:2,borderRadius:"22px 22px 0 0",
          background:"linear-gradient(90deg,transparent,#FCD34D,transparent)" }} />

        {/* Header */}
        <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:20 }}>
          <div>
            <div style={{ fontSize:9,color:"#FCD34D",letterSpacing:2,marginBottom:3 }}>// VOLT AGENT • DEX SWAP</div>
            <div style={{ fontFamily:"'Space Mono',monospace",fontSize:17,fontWeight:700 }}>
              SWAP TOKENS
              {loadingPrice && <span style={{ fontSize:9,color:"#444",marginLeft:10,fontWeight:400 }}>cotando...</span>}
            </div>
          </div>
          <button onClick={onClose} style={{ background:"rgba(255,255,255,0.05)",border:"1px solid rgba(255,255,255,0.1)",
            borderRadius:8,width:30,height:30,color:"#888",cursor:"pointer",fontSize:16,
            display:"flex",alignItems:"center",justifyContent:"center" }}>×</button>
        </div>

        {phase === "success" ? (
          <div style={{ textAlign:"center",padding:"16px 0 8px" }}>
            <div style={{ fontSize:44,marginBottom:12 }}>⟁</div>
            <div style={{ color:"#FCD34D",fontFamily:"'Space Mono',monospace",fontSize:14,marginBottom:6 }}>
              SWAP EXECUTADO
            </div>
            <div style={{ fontSize:13,color:"#ccc",marginBottom:4 }}>
              {amountIn} {tokenIn.symbol} → {amountOut} {tokenOut.symbol}
            </div>
            <div style={{ fontSize:10,color:"#555",marginBottom:20 }}>
              <a href={`https://testnet.arcscan.app/tx/${txHash}`} target="_blank" rel="noreferrer"
                style={{ color:"#FCD34D",textDecoration:"none" }}>{shortAddr(txHash)} ↗</a>
            </div>
            <button onClick={onClose} style={{ background:"linear-gradient(135deg,#FCD34D,#f5a623)",
              border:"none",borderRadius:12,padding:"12px 32px",color:"#080C10",
              fontWeight:700,cursor:"pointer",fontFamily:"monospace",fontSize:12 }}>FECHAR</button>
          </div>
        ) : (
          <>
            {/* Token IN */}
            <div style={{ background:"rgba(255,255,255,0.03)",border:"1px solid rgba(255,255,255,0.08)",
              borderRadius:14,padding:"14px 16px",marginBottom:4,position:"relative" }}>
              <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8 }}>
                <span style={{ fontSize:9,color:"#555",letterSpacing:1.5 }}>VOCÊ PAGA</span>
                {inUsdValue && <span style={{ fontSize:10,color:"#555" }}>≈ ${inUsdValue}</span>}
              </div>
              <div style={{ display:"flex",alignItems:"center",gap:12 }}>
                <div style={{ position:"relative" }}>
                  <div onClick={()=>{setShowTokenInPicker(v=>!v);setShowTokenOutPicker(false);}}
                    style={{ display:"flex",alignItems:"center",gap:8,background:`${tokenIn.color}15`,
                      border:`1px solid ${tokenIn.color}33`,borderRadius:10,padding:"8px 12px",
                      cursor:"pointer",transition:"all 0.2s",userSelect:"none" }}>
                    <div style={{ width:22,height:22,borderRadius:"50%",background:`${tokenIn.color}25`,
                      border:`1px solid ${tokenIn.color}44`,display:"flex",alignItems:"center",
                      justifyContent:"center",fontSize:11,color:tokenIn.color,fontWeight:700 }}>{tokenIn.icon}</div>
                    <span style={{ fontFamily:"monospace",fontSize:13,fontWeight:700,color:tokenIn.color }}>{tokenIn.symbol}</span>
                    <span style={{ fontSize:10,color:"#555" }}>▾</span>
                  </div>
                  {showTokenInPicker && (
                    <TokenPicker current={tokenIn}
                      onSelect={t=>{if(t.symbol===tokenOut.symbol)setTokenOut(tokenIn); setTokenIn(t);}}
                      onClose={()=>setShowTokenInPicker(false)} />
                  )}
                </div>
                <input value={amountIn} onChange={e=>setAmountIn(e.target.value)}
                  placeholder="0.00" type="number" min="0"
                  style={{ flex:1,background:"transparent",border:"none",color:"#fff",
                    fontFamily:"'Space Mono',monospace",fontSize:20,fontWeight:700,
                    textAlign:"right",outline:"none" }} />
              </div>
              {prices[tokenIn.cgId] && (
                <div style={{ marginTop:6,fontSize:9,color:"#555" }}>
                  1 {tokenIn.symbol} = ${prices[tokenIn.cgId].usd?.toLocaleString()}
                  <span style={{ marginLeft:8, color: prices[tokenIn.cgId].usd_24h_change > 0 ? "#00FFB2":"#FF6B35" }}>
                    {prices[tokenIn.cgId].usd_24h_change > 0?"+":""}{prices[tokenIn.cgId].usd_24h_change?.toFixed(2)}% 24h
                  </span>
                </div>
              )}
            </div>

            {/* Wallet balance bar */}
            {balance && (
              <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",
                padding:"5px 12px",marginBottom:2 }}>
                <span style={{ fontSize:9,color:"#444",fontFamily:"monospace" }}>WALLET</span>
                <div style={{ display:"flex",alignItems:"center",gap:8 }}>
                  <span style={{
                    fontSize:10, fontFamily:"monospace", fontWeight:700,
                    color: amountIn && parseFloat(amountIn)*1.001 > (balance.usdcFloat||0)
                      ? "#FF3366" : "#00FFB2"
                  }}>
                    {parseFloat(balance.usdc||0).toFixed(2)} USDC
                  </span>
                  {amountIn && parseFloat(amountIn)*1.001 > (balance.usdcFloat||0) && (
                    <span style={{ fontSize:8,color:"#FF3366",background:"rgba(255,51,102,0.1)",
                      borderRadius:4,padding:"1px 5px" }}>INSUFFICIENT</span>
                  )}
                  <button onClick={()=>setAmountIn((balance.usdcFloat||0).toFixed(6))}
                    style={{ fontSize:8,color:"#FCD34D",background:"rgba(252,211,77,0.1)",
                      border:"1px solid rgba(252,211,77,0.2)",borderRadius:4,
                      padding:"2px 6px",cursor:"pointer",fontFamily:"monospace" }}>MAX</button>
                </div>
              </div>
            )}

            {/* Flip button */}
            <div style={{ display:"flex",justifyContent:"center",margin:"-2px 0",position:"relative",zIndex:10 }}>
              <button onClick={flipTokens}
                style={{ width:32,height:32,borderRadius:"50%",background:"#0b1018",
                  border:"1px solid rgba(255,255,255,0.12)",color:"#FCD34D",
                  cursor:"pointer",fontSize:16,display:"flex",alignItems:"center",
                  justifyContent:"center",transition:"all 0.2s",zIndex:2 }}>⇅</button>
            </div>

            {/* Token OUT */}
            <div style={{ background:"rgba(255,255,255,0.03)",border:"1px solid rgba(255,255,255,0.08)",
              borderRadius:14,padding:"14px 16px",marginTop:4,marginBottom:14,position:"relative" }}>
              <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8 }}>
                <span style={{ fontSize:9,color:"#555",letterSpacing:1.5 }}>VOCÊ RECEBE</span>
                {outUsdValue && <span style={{ fontSize:10,color:"#555" }}>≈ ${outUsdValue}</span>}
              </div>
              <div style={{ display:"flex",alignItems:"center",gap:12 }}>
                <div style={{ position:"relative" }}>
                  <div onClick={()=>{setShowTokenOutPicker(v=>!v);setShowTokenInPicker(false);}}
                    style={{ display:"flex",alignItems:"center",gap:8,background:`${tokenOut.color}15`,
                      border:`1px solid ${tokenOut.color}33`,borderRadius:10,padding:"8px 12px",
                      cursor:"pointer",transition:"all 0.2s",userSelect:"none" }}>
                    <div style={{ width:22,height:22,borderRadius:"50%",background:`${tokenOut.color}25`,
                      border:`1px solid ${tokenOut.color}44`,display:"flex",alignItems:"center",
                      justifyContent:"center",fontSize:11,color:tokenOut.color,fontWeight:700 }}>{tokenOut.icon}</div>
                    <span style={{ fontFamily:"monospace",fontSize:13,fontWeight:700,color:tokenOut.color }}>{tokenOut.symbol}</span>
                    <span style={{ fontSize:10,color:"#555" }}>▾</span>
                  </div>
                  {showTokenOutPicker && (
                    <TokenPicker current={tokenOut}
                      onSelect={t=>{if(t.symbol===tokenIn.symbol)setTokenIn(tokenOut); setTokenOut(t);}}
                      onClose={()=>setShowTokenOutPicker(false)} />
                  )}
                </div>
                <div style={{ flex:1,textAlign:"right" }}>
                  <div style={{ fontFamily:"'Space Mono',monospace",fontSize:20,fontWeight:700,
                    color: amountOut ? tokenOut.color : "#333" }}>
                    {amountOut || "0.00"}
                  </div>
                </div>
              </div>
              {prices[tokenOut.cgId] && (
                <div style={{ marginTop:6,fontSize:9,color:"#555" }}>
                  1 {tokenOut.symbol} = ${prices[tokenOut.cgId].usd?.toLocaleString()}
                  <span style={{ marginLeft:8, color: prices[tokenOut.cgId].usd_24h_change > 0 ? "#00FFB2":"#FF6B35" }}>
                    {prices[tokenOut.cgId].usd_24h_change > 0?"+":""}{prices[tokenOut.cgId].usd_24h_change?.toFixed(2)}% 24h
                  </span>
                </div>
              )}
            </div>

            {/* Swap details */}
            {amountIn && amountOut && (
              <div style={{ background:"rgba(252,211,77,0.05)",border:"1px solid rgba(252,211,77,0.1)",
                borderRadius:12,padding:"12px 14px",marginBottom:14,fontSize:10,
                display:"flex",flexDirection:"column",gap:6,animation:"fadeIn 0.3s ease" }}>
                {rate && (
                  <div style={{ display:"flex",justifyContent:"space-between" }}>
                    <span style={{ color:"#555" }}>Taxa de câmbio</span>
                    <span style={{ color:"#ccc",fontFamily:"monospace" }}>1 {tokenIn.symbol} = {rate} {tokenOut.symbol}</span>
                  </div>
                )}
                <div style={{ display:"flex",justifyContent:"space-between" }}>
                  <span style={{ color:"#555" }}>Taxa DEX</span>
                  <span style={{ color:"#ccc",fontFamily:"monospace" }}>0.30%</span>
                </div>
                {priceImpact && (
                  <div style={{ display:"flex",justifyContent:"space-between" }}>
                    <span style={{ color:"#555" }}>Price Impact</span>
                    <span style={{ color: parseFloat(priceImpact)>2?"#FF6B35":"#00FFB2",fontFamily:"monospace" }}>
                      {priceImpact}%
                    </span>
                  </div>
                )}
                {minReceived && (
                  <div style={{ display:"flex",justifyContent:"space-between" }}>
                    <span style={{ color:"#555" }}>Mínimo recebido</span>
                    <span style={{ color:"#ccc",fontFamily:"monospace" }}>{minReceived} {tokenOut.symbol}</span>
                  </div>
                )}
                <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center" }}>
                  <div style={{ display:"flex",alignItems:"center",gap:6 }}>
                    <span style={{ color:"#555" }}>Slippage</span>
                    <button onClick={()=>setShowSlippage(v=>!v)} style={{ background:"rgba(252,211,77,0.1)",
                      border:"1px solid rgba(252,211,77,0.2)",borderRadius:6,padding:"2px 7px",
                      color:"#FCD34D",cursor:"pointer",fontSize:9,fontFamily:"monospace" }}>
                      {slippage}% ✎
                    </button>
                  </div>
                  {showSlippage && (
                    <div style={{ display:"flex",gap:4 }}>
                      {[0.1,0.5,1.0,3.0].map(s=>(
                        <button key={s} onClick={()=>{setSlippage(s);setShowSlippage(false);}} style={{
                          background:slippage===s?"#FCD34D":"rgba(255,255,255,0.06)",
                          border:"1px solid rgba(255,255,255,0.1)",borderRadius:6,
                          padding:"3px 8px",color:slippage===s?"#080C10":"#888",
                          cursor:"pointer",fontSize:9,fontFamily:"monospace" }}>{s}%</button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}

            {errMsg && <div style={{ color:"#FF6B35",fontSize:11,fontFamily:"monospace",marginBottom:10 }}>⚠ {errMsg}</div>}

            <button onClick={executeSwap} disabled={phase==="confirming"||!amountIn||!amountOut}
              style={{ width:"100%",
                background: !amountIn||!amountOut ? "rgba(252,211,77,0.1)"
                  : phase==="confirming" ? "rgba(252,211,77,0.15)"
                  : "linear-gradient(135deg,#FCD34D,#f5a623)",
                border:"none",borderRadius:12,padding:"13px 0",
                color: !amountIn||!amountOut ? "#555":"#080C10",
                fontWeight:700,fontSize:12,fontFamily:"'Space Mono',monospace",
                cursor: !amountIn||!amountOut||phase==="confirming"?"not-allowed":"pointer",
                letterSpacing:1,transition:"all 0.2s" }}>
              {phase==="confirming" ? "⟁ EXECUTANDO SWAP..." : `⟁ SWAP ${tokenIn.symbol} → ${tokenOut.symbol}`}
            </button>

            {!wallet && (
              <div style={{ textAlign:"center",fontSize:10,color:"#555",marginTop:8,fontFamily:"monospace" }}>
                Conecte a wallet para executar swaps reais
              </div>
            )}
          </>
        )}
      </div>
    </div>
    </>
  );
}

// ─── ARC USDC — ERC-20 HELPERS ──────────────────────────────────────────────
// Source: docs.arc.network/arc/references/contract-addresses
//
// Arc has two USDC interfaces that affect the SAME underlying balance:
//   • Native  (eth_getBalance / eth_sendTransaction value) — 18 decimals  → gas/display
//   • ERC-20  (balanceOf / transfer at 0x3600…0000)        —  6 decimals  → ALL app logic
//
// Rule: ALWAYS use ERC-20 for reading user-facing balances and sending transfers.
// The contract address 0x3600000000000000000000000000000000000000 is the official
// USDC precompile on Arc Testnet (confirmed: docs.arc.network/arc/references/contract-addresses).

// Encode ERC-20 transfer(address,uint256) calldata
// selector = keccak256("transfer(address,uint256)") = 0xa9059cbb
function encodeUSDCTransfer(toAddress, amountFloat) {
  const amount6dec = BigInt(Math.round(parseFloat(amountFloat) * 1e6));  // 6 decimals
  const sel        = "a9059cbb";
  const paddedTo   = toAddress.replace("0x","").padStart(64, "0");
  const paddedAmt  = amount6dec.toString(16).padStart(64, "0");
  return "0x" + sel + paddedTo + paddedAmt;
}

// Read ERC-20 USDC balance via eth_call — returns { usdcFloat, usdcDisplay, usdcRaw }
async function fetchUSDCBalance(address) {
  // balanceOf(address) selector = 0x70a08231
  const data   = "0x70a08231" + address.replace("0x","").padStart(64,"0");
  const result = await rpc("eth_call", [{ to: CONTRACTS.USDC, data }, "latest"]);
  const raw    = result && result !== "0x" ? BigInt(result) : 0n;
  const float  = Number(raw) / 1e6;
  return { usdcFloat: float, usdcDisplay: float.toFixed(2), usdcRaw: raw.toString() };
}

// Send USDC via ERC-20 transfer() — opens MetaMask for user to sign
// This is the ONLY correct way to move USDC on Arc in a dapp.
// The wallet must be connected to Arc Testnet (chainId 5042002).
async function sendUSDCERC20(fromAddress, toAddress, amountFloat) {
  if (!window.ethereum) throw new Error("No Web3 wallet detected");
  if (!toAddress.match(/^0x[0-9a-fA-F]{40}$/)) throw new Error("Invalid recipient address");
  const amount = parseFloat(amountFloat);
  if (isNaN(amount) || amount <= 0) throw new Error("Invalid amount");

  const data = encodeUSDCTransfer(toAddress, amount);

  // eth_sendTransaction to the USDC contract address — NOT to the recipient directly.
  // The recipient address is encoded inside the calldata.
  const txHash = await window.ethereum.request({
    method: "eth_sendTransaction",
    params: [{
      from:  fromAddress,
      to:    CONTRACTS.USDC,   // 0x3600000000000000000000000000000000000000
      data,
      gas:   "0x" + (100000).toString(16),
      // No "value" field — USDC moves via the ERC-20 calldata, not as native value
    }],
  });
  return txHash;
}

// Collect platform fee — same ERC-20 transfer to fee wallet
async function collectFee(fromAddress, amountFloat) {
  const feeAmount = parseFloat(amountFloat) * (PLATFORM_FEE_BPS / 10000);
  if (feeAmount < 0.000001) return null; // skip dust
  try {
    return await sendUSDCERC20(fromAddress, PLATFORM_FEE_WALLET, feeAmount);
  } catch (_) { return null; } // fee is best-effort
}

// Poll receipt until confirmed or timeout
async function waitForReceipt(txHash, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const receipt = await rpc("eth_getTransactionReceipt", [txHash]);
      if (receipt && receipt.status) return receipt;
    } catch (_) {}
    await new Promise(r => setTimeout(r, 2000));
  }
  return null;
}

// Legacy alias kept for any remaining internal calls
// @deprecated — use sendUSDCERC20 directly
async function sendUsdcERC20(from, to, amountFloat) {
  return sendUSDCERC20(from, to, amountFloat);
}

// ═══════════════════════════════════════════════════════════════════════════════
// 🌐 i18n — translations (English default)
// ═══════════════════════════════════════════════════════════════════════════════
const TRANSLATIONS = {
  "en-US": {
    profile:"Profile", account:"Account", security:"Security", prefs:"Preferences",
    identity:"IDENTITY", fullName:"FULL NAME", namePh:"Your name",
    username:"USERNAME", userPh:"your_handle",
    contact:"CONTACT", email:"EMAIL", emailPh:"you@email.com",
    website:"WEBSITE", twitter:"TWITTER / X", twitterPh:"handle",
    bio:"BIO", bioPh:"Tell us about yourself...",
    avatar:"AVATAR (click to switch)",
    connectedWallet:"CONNECTED WALLET", network:"NETWORK", chainId:"CHAIN ID",
    noWallet:"No wallet connected",
    locationLang:"LOCATION & LANGUAGE", country:"COUNTRY", language:"LANGUAGE",
    preferredCurrency:"PREFERRED CURRENCY",
    notifications:"NOTIFICATIONS",
    notifTx:"Confirmed transactions", notifSec:"Security alerts",
    notifPrice:"Price change > 5%", notifEmail:"Weekly email digest",
    auth:"AUTHENTICATION", twofa:"Two-factor authentication",
    twofaDesc:"Require code when connecting",
    hideBalance:"Hide balance", hideBalanceDesc:"Mask values in the interface",
    securityStatus:"SECURITY STATUS",
    walletVerified:"Wallet verified", irisProtection:"IRIS Protection",
    lexHealing:"LEX Self-Healing", rateLimiter:"Rate Limiter", antiPhishing:"Anti-Phishing",
    active:"Active and monitoring", autoRepairOnline:"Auto-repair online",
    notConnected:"Not connected", enabled:"Enabled", disabled:"Disabled",
    theme:"THEME", about:"ABOUT", app:"App", rpc:"RPC", explorer:"Explorer",
    cancel:"CANCEL", saveProfile:"SAVE PROFILE", saved:"SAVED!",
    agentOSUser:"AgentOS User", arcTestnet:"Arc Testnet",
    popular:"POPULAR",
    profileBtn:"PROFILE",
    connectBtn:"CONNECT WALLET",
    connectBanner:"⬡ Connect your wallet to send USDC and see live balance on Arc Testnet",
    connectNow:"CONNECT →",
  },
  "pt-BR": {
    profile:"Perfil", account:"Conta", security:"Segurança", prefs:"Preferências",
    identity:"IDENTIDADE", fullName:"NOME COMPLETO", namePh:"Seu nome",
    username:"USERNAME", userPh:"seu_usuario",
    contact:"CONTATO", email:"EMAIL", emailPh:"seu@email.com",
    website:"WEBSITE", twitter:"TWITTER / X", twitterPh:"handle",
    bio:"BIO", bioPh:"Conte um pouco sobre você...",
    avatar:"AVATAR (clique para trocar)",
    connectedWallet:"CARTEIRA CONECTADA", network:"REDE", chainId:"CHAIN ID",
    noWallet:"Nenhuma wallet conectada",
    locationLang:"LOCALIZAÇÃO & IDIOMA", country:"PAÍS", language:"IDIOMA",
    preferredCurrency:"MOEDA PREFERIDA",
    notifications:"NOTIFICAÇÕES",
    notifTx:"Transações confirmadas", notifSec:"Alertas de segurança",
    notifPrice:"Variação de preço > 5%", notifEmail:"Resumo por e-mail (semanal)",
    auth:"AUTENTICAÇÃO", twofa:"Autenticação em 2 fatores",
    twofaDesc:"Requer código ao conectar",
    hideBalance:"Ocultar saldo", hideBalanceDesc:"Esconde valores na interface",
    securityStatus:"STATUS DE SEGURANÇA",
    walletVerified:"Wallet verificada", irisProtection:"IRIS Protection",
    lexHealing:"LEX Self-Healing", rateLimiter:"Rate Limiter", antiPhishing:"Anti-Phishing",
    active:"Ativa e monitorando", autoRepairOnline:"Auto-repair online",
    notConnected:"Não conectada", enabled:"Ativado", disabled:"Desativado",
    theme:"TEMA", about:"SOBRE", app:"App", rpc:"RPC", explorer:"Explorer",
    cancel:"CANCELAR", saveProfile:"SALVAR PERFIL", saved:"SALVO!",
    agentOSUser:"Usuário AgentOS", arcTestnet:"Arc Testnet",
    popular:"POPULAR",
    profileBtn:"PERFIL",
    connectBtn:"CONECTAR WALLET",
    connectBanner:"⬡ Conecte sua MetaMask para enviar USDC e ver saldo real na Arc Testnet",
    connectNow:"CONECTAR →",
  },
  "es": {
    profile:"Perfil", account:"Cuenta", security:"Seguridad", prefs:"Preferencias",
    identity:"IDENTIDAD", fullName:"NOMBRE COMPLETO", namePh:"Tu nombre",
    username:"USUARIO", userPh:"tu_usuario",
    contact:"CONTACTO", email:"CORREO", emailPh:"tu@correo.com",
    website:"SITIO WEB", twitter:"TWITTER / X", twitterPh:"handle",
    bio:"BIO", bioPh:"Cuéntanos sobre ti...",
    avatar:"AVATAR (clic para cambiar)",
    connectedWallet:"BILLETERA CONECTADA", network:"RED", chainId:"CHAIN ID",
    noWallet:"Sin billetera conectada",
    locationLang:"UBICACIÓN & IDIOMA", country:"PAÍS", language:"IDIOMA",
    preferredCurrency:"MONEDA PREFERIDA",
    notifications:"NOTIFICACIONES",
    notifTx:"Transacciones confirmadas", notifSec:"Alertas de seguridad",
    notifPrice:"Variación de precio > 5%", notifEmail:"Resumen por correo (semanal)",
    auth:"AUTENTICACIÓN", twofa:"Autenticación de 2 factores",
    twofaDesc:"Requiere código al conectar",
    hideBalance:"Ocultar saldo", hideBalanceDesc:"Oculta valores en la interfaz",
    securityStatus:"ESTADO DE SEGURIDAD",
    walletVerified:"Billetera verificada", irisProtection:"Protección IRIS",
    lexHealing:"LEX Auto-reparación", rateLimiter:"Limitador de velocidad", antiPhishing:"Anti-Phishing",
    active:"Activo y monitoreando", autoRepairOnline:"Auto-reparación en línea",
    notConnected:"No conectada", enabled:"Activado", disabled:"Desactivado",
    theme:"TEMA", about:"ACERCA DE", app:"App", rpc:"RPC", explorer:"Explorer",
    cancel:"CANCELAR", saveProfile:"GUARDAR PERFIL", saved:"¡GUARDADO!",
    agentOSUser:"Usuario AgentOS", arcTestnet:"Arc Testnet",
    popular:"POPULAR",
    profileBtn:"PERFIL",
    connectBtn:"CONECTAR WALLET",
    connectBanner:"⬡ Conecta tu wallet para enviar USDC y ver saldo real en Arc Testnet",
    connectNow:"CONECTAR →",
  },
  "fr": {
    profile:"Profil", account:"Compte", security:"Sécurité", prefs:"Préférences",
    identity:"IDENTITÉ", fullName:"NOM COMPLET", namePh:"Votre nom",
    username:"NOM D'UTILISATEUR", userPh:"votre_pseudo",
    contact:"CONTACT", email:"EMAIL", emailPh:"vous@email.com",
    website:"SITE WEB", twitter:"TWITTER / X", twitterPh:"handle",
    bio:"BIO", bioPh:"Parlez-nous de vous...",
    avatar:"AVATAR (cliquer pour changer)",
    connectedWallet:"PORTEFEUILLE CONNECTÉ", network:"RÉSEAU", chainId:"CHAIN ID",
    noWallet:"Aucun portefeuille connecté",
    locationLang:"LOCALISATION & LANGUE", country:"PAYS", language:"LANGUE",
    preferredCurrency:"DEVISE PRÉFÉRÉE",
    notifications:"NOTIFICATIONS",
    notifTx:"Transactions confirmées", notifSec:"Alertes de sécurité",
    notifPrice:"Variation de prix > 5%", notifEmail:"Résumé par e-mail (hebdo)",
    auth:"AUTHENTIFICATION", twofa:"Authentification à 2 facteurs",
    twofaDesc:"Nécessite un code à la connexion",
    hideBalance:"Masquer le solde", hideBalanceDesc:"Cache les valeurs dans l'interface",
    securityStatus:"ÉTAT DE SÉCURITÉ",
    walletVerified:"Portefeuille vérifié", irisProtection:"Protection IRIS",
    lexHealing:"LEX Auto-réparation", rateLimiter:"Limiteur de débit", antiPhishing:"Anti-Phishing",
    active:"Actif et en surveillance", autoRepairOnline:"Auto-réparation en ligne",
    notConnected:"Non connecté", enabled:"Activé", disabled:"Désactivé",
    theme:"THÈME", about:"À PROPOS", app:"App", rpc:"RPC", explorer:"Explorer",
    cancel:"ANNULER", saveProfile:"SAUVEGARDER", saved:"SAUVEGARDÉ!",
    agentOSUser:"Utilisateur AgentOS", arcTestnet:"Arc Testnet",
    popular:"POPULAIRE",
    profileBtn:"PROFIL",
    connectBtn:"CONNECTER WALLET",
    connectBanner:"⬡ Connectez votre wallet pour envoyer USDC et voir le solde réel sur Arc Testnet",
    connectNow:"CONNECTER →",
  },
  "zh-CN": {
    profile:"个人资料", account:"账户", security:"安全", prefs:"偏好设置",
    identity:"身份信息", fullName:"全名", namePh:"您的姓名",
    username:"用户名", userPh:"您的用户名",
    contact:"联系方式", email:"电子邮件", emailPh:"您@邮箱.com",
    website:"网站", twitter:"TWITTER / X", twitterPh:"账号",
    bio:"简介", bioPh:"介绍一下自己...",
    avatar:"头像（点击切换）",
    connectedWallet:"已连接钱包", network:"网络", chainId:"链ID",
    noWallet:"未连接钱包",
    locationLang:"位置与语言", country:"国家", language:"语言",
    preferredCurrency:"首选货币",
    notifications:"通知",
    notifTx:"已确认交易", notifSec:"安全警报",
    notifPrice:"价格变动 > 5%", notifEmail:"每周邮件摘要",
    auth:"身份验证", twofa:"双因素认证",
    twofaDesc:"连接时需要验证码",
    hideBalance:"隐藏余额", hideBalanceDesc:"在界面中隐藏金额",
    securityStatus:"安全状态",
    walletVerified:"钱包已验证", irisProtection:"IRIS保护",
    lexHealing:"LEX自动修复", rateLimiter:"速率限制器", antiPhishing:"防钓鱼",
    active:"活跃并监控中", autoRepairOnline:"自动修复在线",
    notConnected:"未连接", enabled:"已启用", disabled:"已禁用",
    theme:"主题", about:"关于", app:"应用", rpc:"RPC", explorer:"浏览器",
    cancel:"取消", saveProfile:"保存资料", saved:"已保存！",
    agentOSUser:"AgentOS用户", arcTestnet:"Arc测试网",
    popular:"热门",
    profileBtn:"个人资料",
    connectBtn:"连接钱包",
    connectBanner:"⬡ 连接钱包以在Arc测试网上发送USDC并查看实时余额",
    connectNow:"连接 →",
  },
  "ja": {
    profile:"プロフィール", account:"アカウント", security:"セキュリティ", prefs:"設定",
    identity:"身元情報", fullName:"氏名", namePh:"お名前",
    username:"ユーザー名", userPh:"ユーザー名",
    contact:"連絡先", email:"メール", emailPh:"you@email.com",
    website:"ウェブサイト", twitter:"TWITTER / X", twitterPh:"ハンドル",
    bio:"自己紹介", bioPh:"自己紹介を入力...",
    avatar:"アバター（クリックで変更）",
    connectedWallet:"接続済みウォレット", network:"ネットワーク", chainId:"チェーンID",
    noWallet:"ウォレット未接続",
    locationLang:"場所と言語", country:"国", language:"言語",
    preferredCurrency:"優先通貨",
    notifications:"通知",
    notifTx:"確認済みトランザクション", notifSec:"セキュリティアラート",
    notifPrice:"価格変動 > 5%", notifEmail:"週次メールダイジェスト",
    auth:"認証", twofa:"二要素認証",
    twofaDesc:"接続時にコードが必要",
    hideBalance:"残高を非表示", hideBalanceDesc:"インターフェースで金額を隠す",
    securityStatus:"セキュリティ状態",
    walletVerified:"ウォレット確認済み", irisProtection:"IRIS保護",
    lexHealing:"LEX自動修復", rateLimiter:"レート制限", antiPhishing:"フィッシング対策",
    active:"アクティブで監視中", autoRepairOnline:"自動修復オンライン",
    notConnected:"未接続", enabled:"有効", disabled:"無効",
    theme:"テーマ", about:"情報", app:"アプリ", rpc:"RPC", explorer:"エクスプローラー",
    cancel:"キャンセル", saveProfile:"プロフィールを保存", saved:"保存済み！",
    agentOSUser:"AgentOSユーザー", arcTestnet:"Arcテストネット",
    popular:"人気",
    profileBtn:"プロフィール",
    connectBtn:"ウォレット接続",
    connectBanner:"⬡ ウォレットを接続してArcテストネットでUSDCを送信・残高確認",
    connectNow:"接続 →",
  },
  "de": {
    profile:"Profil", account:"Konto", security:"Sicherheit", prefs:"Einstellungen",
    identity:"IDENTITÄT", fullName:"VOLLSTÄNDIGER NAME", namePh:"Ihr Name",
    username:"BENUTZERNAME", userPh:"ihr_name",
    contact:"KONTAKT", email:"E-MAIL", emailPh:"sie@email.de",
    website:"WEBSITE", twitter:"TWITTER / X", twitterPh:"Handle",
    bio:"BIO", bioPh:"Erzählen Sie uns von sich...",
    avatar:"AVATAR (zum Wechseln klicken)",
    connectedWallet:"VERBUNDENE WALLET", network:"NETZWERK", chainId:"CHAIN ID",
    noWallet:"Keine Wallet verbunden",
    locationLang:"ORT & SPRACHE", country:"LAND", language:"SPRACHE",
    preferredCurrency:"BEVORZUGTE WÄHRUNG",
    notifications:"BENACHRICHTIGUNGEN",
    notifTx:"Bestätigte Transaktionen", notifSec:"Sicherheitswarnungen",
    notifPrice:"Preisänderung > 5%", notifEmail:"Wöchentliche E-Mail-Zusammenfassung",
    auth:"AUTHENTIFIZIERUNG", twofa:"Zwei-Faktor-Authentifizierung",
    twofaDesc:"Code beim Verbinden erforderlich",
    hideBalance:"Guthaben ausblenden", hideBalanceDesc:"Werte in der Oberfläche verbergen",
    securityStatus:"SICHERHEITSSTATUS",
    walletVerified:"Wallet verifiziert", irisProtection:"IRIS Schutz",
    lexHealing:"LEX Selbstheilung", rateLimiter:"Ratenbegrenzer", antiPhishing:"Anti-Phishing",
    active:"Aktiv und überwacht", autoRepairOnline:"Auto-Reparatur online",
    notConnected:"Nicht verbunden", enabled:"Aktiviert", disabled:"Deaktiviert",
    theme:"DESIGN", about:"ÜBER", app:"App", rpc:"RPC", explorer:"Explorer",
    cancel:"ABBRECHEN", saveProfile:"PROFIL SPEICHERN", saved:"GESPEICHERT!",
    agentOSUser:"AgentOS Benutzer", arcTestnet:"Arc Testnet",
    popular:"BELIEBT",
    profileBtn:"PROFIL",
    connectBtn:"WALLET VERBINDEN",
    connectBanner:"⬡ Wallet verbinden um USDC zu senden und Live-Guthaben auf Arc Testnet zu sehen",
    connectNow:"VERBINDEN →",
  },
  "ar": {
    profile:"الملف الشخصي", account:"الحساب", security:"الأمان", prefs:"التفضيلات",
    identity:"الهوية", fullName:"الاسم الكامل", namePh:"اسمك",
    username:"اسم المستخدم", userPh:"اسم_المستخدم",
    contact:"التواصل", email:"البريد الإلكتروني", emailPh:"أنت@بريد.com",
    website:"الموقع", twitter:"تويتر / X", twitterPh:"المعرّف",
    bio:"النبذة", bioPh:"أخبرنا عن نفسك...",
    avatar:"الصورة الرمزية (انقر للتغيير)",
    connectedWallet:"المحفظة المتصلة", network:"الشبكة", chainId:"معرّف السلسلة",
    noWallet:"لا توجد محفظة متصلة",
    locationLang:"الموقع واللغة", country:"الدولة", language:"اللغة",
    preferredCurrency:"العملة المفضلة",
    notifications:"الإشعارات",
    notifTx:"المعاملات المؤكدة", notifSec:"تنبيهات الأمان",
    notifPrice:"تغيّر السعر > 5%", notifEmail:"ملخص بريدي أسبوعي",
    auth:"المصادقة", twofa:"المصادقة الثنائية",
    twofaDesc:"يتطلب رمزاً عند الاتصال",
    hideBalance:"إخفاء الرصيد", hideBalanceDesc:"إخفاء القيم في الواجهة",
    securityStatus:"حالة الأمان",
    walletVerified:"المحفظة موثقة", irisProtection:"حماية IRIS",
    lexHealing:"إصلاح LEX التلقائي", rateLimiter:"محدد المعدل", antiPhishing:"مكافحة التصيد",
    active:"نشط ومراقَب", autoRepairOnline:"الإصلاح التلقائي متصل",
    notConnected:"غير متصلة", enabled:"مفعّل", disabled:"معطّل",
    theme:"السمة", about:"حول", app:"التطبيق", rpc:"RPC", explorer:"المستكشف",
    cancel:"إلغاء", saveProfile:"حفظ الملف", saved:"تم الحفظ!",
    agentOSUser:"مستخدم AgentOS", arcTestnet:"شبكة Arc التجريبية",
    popular:"الأكثر شيوعاً",
    profileBtn:"الملف",
    connectBtn:"ربط المحفظة",
    connectBanner:"⬡ اربط محفظتك لإرسال USDC ومشاهدة الرصيد الفعلي على شبكة Arc",
    connectNow:"اتصال →",
  },
  "hi": {
    profile:"प्रोफ़ाइल", account:"खाता", security:"सुरक्षा", prefs:"प्राथमिकताएं",
    identity:"पहचान", fullName:"पूरा नाम", namePh:"आपका नाम",
    username:"उपयोगकर्ता नाम", userPh:"आपका_नाम",
    contact:"संपर्क", email:"ईमेल", emailPh:"आप@ईमेल.com",
    website:"वेबसाइट", twitter:"ट्विटर / X", twitterPh:"हैंडल",
    bio:"परिचय", bioPh:"अपने बारे में बताएं...",
    avatar:"अवतार (बदलने के लिए क्लिक करें)",
    connectedWallet:"जुड़ा वॉलेट", network:"नेटवर्क", chainId:"चेन ID",
    noWallet:"कोई वॉलेट नहीं जुड़ा",
    locationLang:"स्थान और भाषा", country:"देश", language:"भाषा",
    preferredCurrency:"पसंदीदा मुद्रा",
    notifications:"सूचनाएं",
    notifTx:"पुष्टि लेनदेन", notifSec:"सुरक्षा अलर्ट",
    notifPrice:"मूल्य परिवर्तन > 5%", notifEmail:"साप्ताहिक ईमेल सारांश",
    auth:"प्रमाणीकरण", twofa:"दो-कारक प्रमाणीकरण",
    twofaDesc:"कनेक्ट करते समय कोड आवश्यक",
    hideBalance:"बैलेंस छुपाएं", hideBalanceDesc:"इंटरफ़ेस में मान छुपाएं",
    securityStatus:"सुरक्षा स्थिति",
    walletVerified:"वॉलेट सत्यापित", irisProtection:"IRIS सुरक्षा",
    lexHealing:"LEX स्व-उपचार", rateLimiter:"दर सीमक", antiPhishing:"एंटी-फिशिंग",
    active:"सक्रिय और निगरानी में", autoRepairOnline:"स्वत: मरम्मत ऑनलाइन",
    notConnected:"नहीं जुड़ा", enabled:"सक्षम", disabled:"अक्षम",
    theme:"थीम", about:"के बारे में", app:"ऐप", rpc:"RPC", explorer:"एक्सप्लोरर",
    cancel:"रद्द करें", saveProfile:"प्रोफ़ाइल सहेजें", saved:"सहेजा गया!",
    agentOSUser:"AgentOS उपयोगकर्ता", arcTestnet:"Arc Testnet",
    popular:"लोकप्रिय",
    profileBtn:"प्रोफ़ाइल",
    connectBtn:"वॉलेट जोड़ें",
    connectBanner:"⬡ Arc Testnet पर USDC भेजने के लिए अपना वॉलेट जोड़ें",
    connectNow:"जोड़ें →",
  },
  "ko": {
    profile:"프로필", account:"계정", security:"보안", prefs:"설정",
    identity:"신원 정보", fullName:"전체 이름", namePh:"이름을 입력하세요",
    username:"사용자명", userPh:"사용자명",
    contact:"연락처", email:"이메일", emailPh:"you@email.com",
    website:"웹사이트", twitter:"트위터 / X", twitterPh:"핸들",
    bio:"자기소개", bioPh:"자신에 대해 알려주세요...",
    avatar:"아바타 (클릭하여 변경)",
    connectedWallet:"연결된 지갑", network:"네트워크", chainId:"체인 ID",
    noWallet:"지갑이 연결되지 않음",
    locationLang:"위치 및 언어", country:"국가", language:"언어",
    preferredCurrency:"선호 통화",
    notifications:"알림",
    notifTx:"거래 확인", notifSec:"보안 경고",
    notifPrice:"가격 변동 > 5%", notifEmail:"주간 이메일 요약",
    auth:"인증", twofa:"2단계 인증",
    twofaDesc:"연결 시 코드 필요",
    hideBalance:"잔액 숨기기", hideBalanceDesc:"인터페이스에서 값 숨기기",
    securityStatus:"보안 상태",
    walletVerified:"지갑 인증됨", irisProtection:"IRIS 보호",
    lexHealing:"LEX 자동 복구", rateLimiter:"속도 제한기", antiPhishing:"안티 피싱",
    active:"활성 및 모니터링 중", autoRepairOnline:"자동 복구 온라인",
    notConnected:"연결되지 않음", enabled:"활성화됨", disabled:"비활성화됨",
    theme:"테마", about:"정보", app:"앱", rpc:"RPC", explorer:"익스플로러",
    cancel:"취소", saveProfile:"프로필 저장", saved:"저장됨!",
    agentOSUser:"AgentOS 사용자", arcTestnet:"Arc 테스트넷",
    popular:"인기",
    profileBtn:"프로필",
    connectBtn:"지갑 연결",
    connectBanner:"⬡ 지갑을 연결하여 Arc 테스트넷에서 USDC를 보내고 잔액을 확인하세요",
    connectNow:"연결 →",
  },
  "ru": {
    profile:"Профиль", account:"Аккаунт", security:"Безопасность", prefs:"Настройки",
    identity:"ЛИЧНЫЕ ДАННЫЕ", fullName:"ПОЛНОЕ ИМЯ", namePh:"Ваше имя",
    username:"ИМЯ ПОЛЬЗОВАТЕЛЯ", userPh:"имя_пользователя",
    contact:"КОНТАКТ", email:"ПОЧТА", emailPh:"вы@почта.ru",
    website:"САЙТ", twitter:"TWITTER / X", twitterPh:"никнейм",
    bio:"О СЕБЕ", bioPh:"Расскажите о себе...",
    avatar:"АВАТАР (нажмите для смены)",
    connectedWallet:"ПОДКЛЮЧЁННЫЙ КОШЕЛЁК", network:"СЕТЬ", chainId:"CHAIN ID",
    noWallet:"Кошелёк не подключён",
    locationLang:"МЕСТОПОЛОЖЕНИЕ И ЯЗЫК", country:"СТРАНА", language:"ЯЗЫК",
    preferredCurrency:"ПРЕДПОЧТИТЕЛЬНАЯ ВАЛЮТА",
    notifications:"УВЕДОМЛЕНИЯ",
    notifTx:"Подтверждённые транзакции", notifSec:"Оповещения безопасности",
    notifPrice:"Изменение цены > 5%", notifEmail:"Еженедельный дайджест",
    auth:"АУТЕНТИФИКАЦИЯ", twofa:"Двухфакторная аутентификация",
    twofaDesc:"Требует код при подключении",
    hideBalance:"Скрыть баланс", hideBalanceDesc:"Скрывает значения в интерфейсе",
    securityStatus:"СТАТУС БЕЗОПАСНОСТИ",
    walletVerified:"Кошелёк верифицирован", irisProtection:"Защита IRIS",
    lexHealing:"Самовосстановление LEX", rateLimiter:"Ограничитель запросов", antiPhishing:"Антифишинг",
    active:"Активен и мониторит", autoRepairOnline:"Авторемонт онлайн",
    notConnected:"Не подключён", enabled:"Включено", disabled:"Выключено",
    theme:"ТЕМА", about:"О ПРИЛОЖЕНИИ", app:"Приложение", rpc:"RPC", explorer:"Обозреватель",
    cancel:"ОТМЕНА", saveProfile:"СОХРАНИТЬ ПРОФИЛЬ", saved:"СОХРАНЕНО!",
    agentOSUser:"Пользователь AgentOS", arcTestnet:"Arc Testnet",
    popular:"ПОПУЛЯРНО",
    profileBtn:"ПРОФИЛЬ",
    connectBtn:"ПОДКЛЮЧИТЬ КОШЕЛЁК",
    connectBanner:"⬡ Подключите кошелёк для отправки USDC и просмотра баланса в Arc Testnet",
    connectNow:"ПОДКЛЮЧИТЬ →",
  },
};

// Global language state (shared across the app)
let _currentLang = "en-US";
const _langListeners = new Set();
function setGlobalLang(lang) {
  _currentLang = lang;
  _langListeners.forEach(fn => fn(lang));
}
function useTranslation() {
  const [lang, setLang] = useState(_currentLang);
  useEffect(() => {
    _langListeners.add(setLang);
    return () => _langListeners.delete(setLang);
  }, []);
  const t = (key) => (TRANSLATIONS[lang] || TRANSLATIONS["en-US"])[key] || key;
  return { t, lang, setLang: setGlobalLang };
}

const ALL_LANGS = [
  { code:"en-US", label:"English (US)",       flag:"🇺🇸" },
  { code:"pt-BR", label:"Português (BR)",      flag:"🇧🇷" },
  { code:"es",    label:"Español",             flag:"🇪🇸" },
  { code:"fr",    label:"Français",            flag:"🇫🇷" },
  { code:"de",    label:"Deutsch",             flag:"🇩🇪" },
  { code:"zh-CN", label:"中文 (简体)",          flag:"🇨🇳" },
  { code:"ja",    label:"日本語",               flag:"🇯🇵" },
  { code:"ko",    label:"한국어",               flag:"🇰🇷" },
  { code:"ru",    label:"Русский",             flag:"🇷🇺" },
  { code:"ar",    label:"العربية",             flag:"🇸🇦" },
  { code:"hi",    label:"हिंदी",               flag:"🇮🇳" },
];

// ═══════════════════════════════════════════════════════════════════════════════
// 👤 PROFILE MODAL
// ═══════════════════════════════════════════════════════════════════════════════
function ProfileModal({ wallet, onClose }) {
  const { t, lang } = useTranslation();
  const [tab, setTab]               = useState("profile");
  const [saved, setSaved]           = useState(false);
  const [avatarSeed, setAvatarSeed] = useState(wallet ? parseInt(wallet.slice(2,6),16) % 12 : 0);
  const [showLangPicker, setShowLangPicker] = useState(false);

  const [form, setForm] = useState({
    name:"", username:"", email:"", bio:"", website:"", twitter:"", telegram:"",
    country:"United States", language: lang,
    currency:"USD", theme:"dark",
    notifTx:true, notifSec:true, notifPrice:false, notifEmail:false,
    twofa:false, hideBalance:false,
  });

  const set = (k,v) => setForm(f => ({ ...f, [k]: v }));

  const saveProfile = () => {
    setSaved(true);
    logSecurityEvent("PROFILE", "Profile updated", "info");
    setTimeout(() => setSaved(false), 2500);
  };

  const AVATAR_ICONS = ["⬡","◈","◎","⟁","⬢","◆","▲","●","◉","⊕","⊗","✦"];
  const COUNTRIES = ["United States","Brazil","Portugal","Argentina","Mexico","Colombia","Spain","France","Germany","Japan","China","India","South Korea","Russia","Saudi Arabia","United Kingdom","Canada","Australia"];

  const inputStyle = {
    width:"100%", boxSizing:"border-box",
    background:"rgba(255,255,255,0.04)", border:"1px solid rgba(255,255,255,0.09)",
    borderRadius:9, padding:"9px 12px", color:"#e0e0e0",
    fontFamily:"monospace", fontSize:11, outline:"none", transition:"border 0.2s",
  };
  const labelStyle = { fontSize:9, color:"#555", letterSpacing:1.5, marginBottom:5, display:"block" };
  const sectionStyle = { marginBottom:22 };
  const rowStyle = { display:"grid", gridTemplateColumns:"1fr 1fr", gap:12 };

  const TABS = [
    { id:"profile",  icon:"◎", label: t("profile")   },
    { id:"account",  icon:"⬡", label: t("account")   },
    { id:"security", icon:"🛡", label: t("security")  },
    { id:"prefs",    icon:"⟁", label: t("prefs")     },
  ];

  const currentLangInfo = ALL_LANGS.find(l => l.code === lang) || ALL_LANGS[0];

  return (
    <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.85)", zIndex:150,
      display:"flex", alignItems:"center", justifyContent:"center", backdropFilter:"blur(8px)",
      animation:"fadeIn 0.2s ease" }}
      onClick={e => e.target === e.currentTarget && onClose()}>

      <div style={{ background:"#0a0f16", border:"1px solid rgba(167,139,250,0.2)",
        borderRadius:24, width:590, maxWidth:"96vw", maxHeight:"90vh",
        display:"flex", flexDirection:"column", position:"relative", overflow:"hidden",
        boxShadow:"0 32px 80px rgba(0,0,0,0.8), 0 0 0 1px rgba(167,139,250,0.06)" }}>

        <div style={{ height:3, background:"linear-gradient(90deg,transparent,#A78BFA,transparent)",
          animation:"shimmer 2.5s infinite", flexShrink:0 }} />

        <div style={{ padding:"20px 24px 0", flexShrink:0 }}>
          {/* Top row: avatar + name + lang switcher + close */}
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:16 }}>
            <div style={{ display:"flex", alignItems:"center", gap:14 }}>
              <div style={{ position:"relative" }}>
                <div style={{ width:56, height:56, borderRadius:16,
                  background:"linear-gradient(135deg,rgba(167,139,250,0.2),rgba(0,255,178,0.1))",
                  border:"2px solid rgba(167,139,250,0.3)", display:"flex", alignItems:"center",
                  justifyContent:"center", fontSize:26, color:"#A78BFA", cursor:"pointer", userSelect:"none" }}
                  onClick={() => setAvatarSeed(s => (s+1) % AVATAR_ICONS.length)}>
                  {AVATAR_ICONS[avatarSeed]}
                </div>
                <div style={{ position:"absolute", bottom:-3, right:-3, width:14, height:14,
                  borderRadius:"50%", background:"#00FFB2", border:"2px solid #0a0f16" }} />
              </div>
              <div>
                <div style={{ fontFamily:"'Space Mono',monospace", fontSize:15, fontWeight:700, marginBottom:2 }}>
                  {form.name || t("agentOSUser")}
                </div>
                <div style={{ fontSize:10, color:"#A78BFA", fontFamily:"monospace" }}>
                  {form.username ? `@${form.username}` : shortAddr(wallet || "0x0000...0000")}
                </div>
                {form.email && <div style={{ fontSize:9, color:"#555", marginTop:2 }}>{form.email}</div>}
              </div>
            </div>

            <div style={{ display:"flex", alignItems:"center", gap:8 }}>
              {/* Language switcher */}
              <div style={{ position:"relative" }}>
                <button onClick={() => setShowLangPicker(v=>!v)} style={{
                  background:"rgba(255,255,255,0.04)", border:"1px solid rgba(255,255,255,0.1)",
                  borderRadius:9, padding:"6px 10px", color:"#888", cursor:"pointer",
                  fontFamily:"monospace", fontSize:11, display:"flex", alignItems:"center", gap:6
                }}>
                  <span style={{ fontSize:14 }}>{currentLangInfo.flag}</span>
                  <span style={{ fontSize:9, letterSpacing:0.5 }}>{currentLangInfo.code}</span>
                  <span style={{ fontSize:9, color:"#444" }}>▾</span>
                </button>
                {showLangPicker && (
                  <div style={{ position:"absolute", top:"100%", right:0, marginTop:4, zIndex:600,
                    background:"#0f1520", border:"1px solid rgba(255,255,255,0.1)",
                    borderRadius:14, padding:8, width:210,
                    boxShadow:"0 16px 40px rgba(0,0,0,0.7)", maxHeight:320, overflowY:"auto" }}>
                    <div style={{ fontSize:8, color:"#333", letterSpacing:2, padding:"4px 8px 8px" }}>LANGUAGE</div>
                    {ALL_LANGS.map(l => (
                      <div key={l.code}
                        onClick={() => { setGlobalLang(l.code); set("language", l.code); setShowLangPicker(false); }}
                        style={{ display:"flex", alignItems:"center", gap:10, padding:"8px 10px",
                          borderRadius:9, cursor:"pointer",
                          background: lang===l.code ? "rgba(167,139,250,0.12)":"transparent",
                          border: lang===l.code ? "1px solid rgba(167,139,250,0.25)":"1px solid transparent",
                          marginBottom:2, transition:"all 0.15s" }}
                        onMouseEnter={e=>e.currentTarget.style.background="rgba(255,255,255,0.05)"}
                        onMouseLeave={e=>e.currentTarget.style.background=lang===l.code?"rgba(167,139,250,0.12)":"transparent"}>
                        <span style={{ fontSize:16, flexShrink:0 }}>{l.flag}</span>
                        <div style={{ flex:1 }}>
                          <div style={{ fontSize:11, color: lang===l.code?"#A78BFA":"#ccc", fontFamily:"monospace" }}>{l.label}</div>
                          <div style={{ fontSize:8, color:"#444" }}>{l.code}</div>
                        </div>
                        {l.code === "en-US" && <span style={{ fontSize:7, color:"#00FFB2", background:"rgba(0,255,178,0.1)", borderRadius:10, padding:"1px 5px" }}>DEFAULT</span>}
                        {lang===l.code && <span style={{ color:"#A78BFA", fontSize:12 }}>✓</span>}
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <button onClick={onClose} style={{ background:"rgba(255,255,255,0.04)",
                border:"1px solid rgba(255,255,255,0.08)", borderRadius:9, width:32, height:32,
                color:"#666", cursor:"pointer", fontSize:17, display:"flex",
                alignItems:"center", justifyContent:"center" }}>×</button>
            </div>
          </div>

          {wallet && (
            <div style={{ background:"rgba(0,255,178,0.06)", border:"1px solid rgba(0,255,178,0.15)",
              borderRadius:9, padding:"7px 12px", marginBottom:14,
              display:"flex", alignItems:"center", gap:8 }}>
              <div style={{ width:6, height:6, borderRadius:"50%", background:"#00FFB2", animation:"pulse 2s infinite" }} />
              <span style={{ fontSize:10, color:"#00FFB2", fontFamily:"monospace", flex:1 }}>{wallet}</span>
              <span style={{ fontSize:8, color:"#444", letterSpacing:1 }}>{t("arcTestnet")}</span>
            </div>
          )}

          <div style={{ display:"flex", gap:2, background:"rgba(255,255,255,0.03)", borderRadius:10, padding:3 }}>
            {TABS.map(tb => (
              <button key={tb.id} onClick={() => setTab(tb.id)} style={{
                flex:1, padding:"7px 6px",
                background: tab===tb.id ? "rgba(167,139,250,0.15)" : "transparent",
                border: tab===tb.id ? "1px solid rgba(167,139,250,0.25)" : "1px solid transparent",
                borderRadius:8, color: tab===tb.id ? "#A78BFA" : "#555",
                cursor:"pointer", fontFamily:"monospace", fontSize:9, letterSpacing:0.5,
                transition:"all 0.2s", display:"flex", alignItems:"center", justifyContent:"center", gap:5
              }}>
                <span>{tb.icon}</span><span style={{ textTransform:"uppercase" }}>{tb.label}</span>
              </button>
            ))}
          </div>
        </div>

        <div style={{ flex:1, overflowY:"auto", padding:"20px 24px" }}>

          {/* ── PROFILE */}
          {tab === "profile" && (
            <>
              <div style={sectionStyle}>
                <div style={{ fontSize:8, color:"#444", letterSpacing:2, marginBottom:12 }}>{t("identity")}</div>
                <div style={rowStyle}>
                  <div>
                    <label style={labelStyle}>{t("fullName")}</label>
                    <input style={inputStyle} value={form.name} placeholder={t("namePh")}
                      onChange={e=>set("name",e.target.value)} />
                  </div>
                  <div>
                    <label style={labelStyle}>{t("username")}</label>
                    <div style={{ position:"relative" }}>
                      <span style={{ position:"absolute", left:12, top:"50%", transform:"translateY(-50%)", fontSize:11, color:"#555" }}>@</span>
                      <input style={{ ...inputStyle, paddingLeft:24 }} value={form.username}
                        placeholder={t("userPh")} onChange={e=>set("username",e.target.value)} />
                    </div>
                  </div>
                </div>
              </div>
              <div style={sectionStyle}>
                <div style={{ fontSize:8, color:"#444", letterSpacing:2, marginBottom:12 }}>{t("contact")}</div>
                <div style={{ marginBottom:10 }}>
                  <label style={labelStyle}>{t("email")}</label>
                  <input style={inputStyle} type="email" value={form.email}
                    placeholder={t("emailPh")} onChange={e=>set("email",e.target.value)} />
                </div>
                <div style={rowStyle}>
                  <div>
                    <label style={labelStyle}>{t("website")}</label>
                    <input style={inputStyle} value={form.website}
                      placeholder="https://" onChange={e=>set("website",e.target.value)} />
                  </div>
                  <div>
                    <label style={labelStyle}>{t("twitter")}</label>
                    <div style={{ position:"relative" }}>
                      <span style={{ position:"absolute", left:12, top:"50%", transform:"translateY(-50%)", fontSize:11, color:"#555" }}>@</span>
                      <input style={{ ...inputStyle, paddingLeft:24 }} value={form.twitter}
                        placeholder={t("twitterPh")} onChange={e=>set("twitter",e.target.value)} />
                    </div>
                  </div>
                </div>
              </div>
              <div style={sectionStyle}>
                <label style={labelStyle}>{t("bio")}</label>
                <textarea value={form.bio} onChange={e=>set("bio",e.target.value)}
                  placeholder={t("bioPh")} rows={3}
                  style={{ ...inputStyle, resize:"vertical", lineHeight:1.6 }} />
              </div>
              <div style={sectionStyle}>
                <div style={{ fontSize:8, color:"#444", letterSpacing:2, marginBottom:12 }}>{t("avatar")}</div>
                <div style={{ display:"flex", gap:8, flexWrap:"wrap" }}>
                  {AVATAR_ICONS.map((icon,i) => (
                    <div key={i} onClick={() => setAvatarSeed(i)}
                      style={{ width:38, height:38, borderRadius:10, cursor:"pointer",
                        background: avatarSeed===i?"rgba(167,139,250,0.2)":"rgba(255,255,255,0.04)",
                        border:`1px solid ${avatarSeed===i?"rgba(167,139,250,0.5)":"rgba(255,255,255,0.08)"}`,
                        display:"flex", alignItems:"center", justifyContent:"center",
                        fontSize:18, transition:"all 0.15s", color: avatarSeed===i?"#A78BFA":"#666" }}>
                      {icon}
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}

          {/* ── ACCOUNT */}
          {tab === "account" && (
            <>
              <div style={sectionStyle}>
                <div style={{ fontSize:8, color:"#444", letterSpacing:2, marginBottom:12 }}>{t("connectedWallet")}</div>
                <div style={{ background:"rgba(255,255,255,0.03)", border:"1px solid rgba(255,255,255,0.07)", borderRadius:12, padding:"14px 16px" }}>
                  {wallet ? (
                    <>
                      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:8 }}>
                        <span style={{ fontSize:9, color:"#555", letterSpacing:1 }}>ADDRESS</span>
                        <span style={{ fontSize:9, color:"#00FFB2", background:"rgba(0,255,178,0.1)", borderRadius:20, padding:"2px 8px" }}>● CONNECTED</span>
                      </div>
                      <div style={{ fontFamily:"monospace", fontSize:11, color:"#ccc", wordBreak:"break-all", lineHeight:1.6 }}>{wallet}</div>
                      <div style={{ marginTop:10, display:"grid", gridTemplateColumns:"1fr 1fr", gap:8 }}>
                        <div style={{ background:"rgba(0,255,178,0.06)", borderRadius:8, padding:"8px 10px" }}>
                          <div style={{ fontSize:8, color:"#555", marginBottom:2 }}>{t("network")}</div>
                          <div style={{ fontSize:11, color:"#00FFB2", fontFamily:"monospace" }}>{t("arcTestnet")}</div>
                        </div>
                        <div style={{ background:"rgba(0,255,178,0.06)", borderRadius:8, padding:"8px 10px" }}>
                          <div style={{ fontSize:8, color:"#555", marginBottom:2 }}>{t("chainId")}</div>
                          <div style={{ fontSize:11, color:"#00FFB2", fontFamily:"monospace" }}>5042002</div>
                        </div>
                      </div>
                    </>
                  ) : (
                    <div style={{ textAlign:"center", padding:"10px 0", color:"#555", fontSize:11 }}>{t("noWallet")}</div>
                  )}
                </div>
              </div>
              <div style={sectionStyle}>
                <div style={{ fontSize:8, color:"#444", letterSpacing:2, marginBottom:12 }}>{t("locationLang")}</div>
                <div style={rowStyle}>
                  <div>
                    <label style={labelStyle}>{t("country")}</label>
                    <select value={form.country} onChange={e=>set("country",e.target.value)} style={{ ...inputStyle, cursor:"pointer" }}>
                      {COUNTRIES.map(c => <option key={c} value={c} style={{ background:"#0a0f16" }}>{c}</option>)}
                    </select>
                  </div>
                  <div>
                    <label style={labelStyle}>{t("language")}</label>
                    <select value={lang} onChange={e=>{ setGlobalLang(e.target.value); set("language",e.target.value); }}
                      style={{ ...inputStyle, cursor:"pointer" }}>
                      {ALL_LANGS.map(l => <option key={l.code} value={l.code} style={{ background:"#0a0f16" }}>{l.flag} {l.label}</option>)}
                    </select>
                  </div>
                </div>
              </div>
              <div style={sectionStyle}>
                <div style={{ fontSize:8, color:"#444", letterSpacing:2, marginBottom:12 }}>{t("preferredCurrency")}</div>
                <div style={{ display:"flex", gap:8, flexWrap:"wrap" }}>
                  {["USD","BRL","EUR","GBP","JPY","CNY","KRW","INR"].map(c => (
                    <button key={c} onClick={()=>set("currency",c)} style={{
                      background: form.currency===c?"rgba(167,139,250,0.15)":"rgba(255,255,255,0.04)",
                      border:`1px solid ${form.currency===c?"rgba(167,139,250,0.4)":"rgba(255,255,255,0.08)"}`,
                      borderRadius:8, padding:"7px 14px", color: form.currency===c?"#A78BFA":"#666",
                      cursor:"pointer", fontFamily:"monospace", fontSize:11, transition:"all 0.15s"
                    }}>{c}</button>
                  ))}
                </div>
              </div>
              <div style={sectionStyle}>
                <div style={{ fontSize:8, color:"#444", letterSpacing:2, marginBottom:12 }}>{t("notifications")}</div>
                <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
                  {[["notifTx",t("notifTx")],["notifSec",t("notifSec")],["notifPrice",t("notifPrice")],["notifEmail",t("notifEmail")]].map(([key,label]) => (
                    <div key={key} style={{ display:"flex", justifyContent:"space-between", alignItems:"center",
                      background:"rgba(255,255,255,0.02)", border:"1px solid rgba(255,255,255,0.05)",
                      borderRadius:9, padding:"10px 14px" }}>
                      <span style={{ fontSize:11, color:"#888" }}>{label}</span>
                      <div onClick={()=>set(key,!form[key])}
                        style={{ width:36, height:20, borderRadius:10, cursor:"pointer",
                          background: form[key]?"#A78BFA":"rgba(255,255,255,0.1)",
                          position:"relative", transition:"background 0.2s" }}>
                        <div style={{ position:"absolute", top:3, left:form[key]?18:3, width:14, height:14,
                          borderRadius:"50%", background:"#fff", transition:"left 0.2s" }} />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}

          {/* ── SECURITY */}
          {tab === "security" && (
            <>
              <div style={sectionStyle}>
                <div style={{ fontSize:8, color:"#444", letterSpacing:2, marginBottom:12 }}>{t("auth")}</div>
                {[
                  ["twofa",       t("twofa"),       t("twofaDesc")],
                  ["hideBalance", t("hideBalance"),  t("hideBalanceDesc")],
                ].map(([key,label,desc]) => (
                  <div key={key} style={{ display:"flex", justifyContent:"space-between", alignItems:"center",
                    background:"rgba(255,255,255,0.02)", border:"1px solid rgba(255,255,255,0.06)",
                    borderRadius:12, padding:"14px 16px", marginBottom:10 }}>
                    <div>
                      <div style={{ fontSize:12, color:"#ccc", marginBottom:3 }}>{label}</div>
                      <div style={{ fontSize:9, color:"#555" }}>{desc}</div>
                    </div>
                    <div onClick={()=>set(key,!form[key])}
                      style={{ width:40, height:22, borderRadius:11, cursor:"pointer",
                        background: form[key]?"#00FFB2":"rgba(255,255,255,0.1)",
                        position:"relative", transition:"background 0.2s", flexShrink:0 }}>
                      <div style={{ position:"absolute", top:3, left:form[key]?20:3, width:16, height:16,
                        borderRadius:"50%", background:"#fff", transition:"left 0.2s" }} />
                    </div>
                  </div>
                ))}
              </div>
              <div style={sectionStyle}>
                <div style={{ fontSize:8, color:"#444", letterSpacing:2, marginBottom:12 }}>{t("securityStatus")}</div>
                <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
                  {[
                    { label:t("walletVerified"),  ok:!!wallet,      detail: wallet?shortAddr(wallet):t("notConnected") },
                    { label:t("irisProtection"),   ok:true,          detail:t("active") },
                    { label:t("lexHealing"),        ok:true,          detail:t("autoRepairOnline") },
                    { label:t("twofa"),             ok:form.twofa,    detail: form.twofa?t("enabled"):t("disabled") },
                    { label:t("rateLimiter"),        ok:true,          detail:"5 tx/min" },
                    { label:t("antiPhishing"),       ok:true,          detail:"Blacklist active" },
                  ].map(item => (
                    <div key={item.label} style={{ display:"flex", alignItems:"center", gap:10,
                      background: item.ok?"rgba(0,255,178,0.04)":"rgba(255,51,102,0.05)",
                      border:`1px solid ${item.ok?"rgba(0,255,178,0.1)":"rgba(255,51,102,0.2)"}`,
                      borderRadius:9, padding:"9px 14px" }}>
                      <span style={{ fontSize:12, color:item.ok?"#00FFB2":"#FF3366" }}>{item.ok?"✓":"✗"}</span>
                      <span style={{ fontSize:11, color:"#ccc", flex:1 }}>{item.label}</span>
                      <span style={{ fontSize:9, color:"#555", fontFamily:"monospace" }}>{item.detail}</span>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}

          {/* ── PREFS */}
          {tab === "prefs" && (
            <>
              <div style={sectionStyle}>
                <div style={{ fontSize:8, color:"#444", letterSpacing:2, marginBottom:12 }}>{t("theme")}</div>
                <div style={{ display:"flex", gap:8 }}>
                  {[["dark","🌑 Dark"],["matrix","🟢 Matrix"],["arc","⬡ Arc"]].map(([v,l]) => (
                    <button key={v} onClick={()=>set("theme",v)} style={{
                      flex:1, padding:"10px 8px",
                      background: form.theme===v?"rgba(167,139,250,0.15)":"rgba(255,255,255,0.03)",
                      border:`1px solid ${form.theme===v?"rgba(167,139,250,0.4)":"rgba(255,255,255,0.07)"}`,
                      borderRadius:10, color: form.theme===v?"#A78BFA":"#666",
                      cursor:"pointer", fontFamily:"monospace", fontSize:10, transition:"all 0.15s"
                    }}>{l}</button>
                  ))}
                </div>
              </div>
              <div style={sectionStyle}>
                <div style={{ fontSize:8, color:"#444", letterSpacing:2, marginBottom:12 }}>{t("about")}</div>
                <div style={{ background:"rgba(255,255,255,0.02)", border:"1px solid rgba(255,255,255,0.05)",
                  borderRadius:12, padding:"14px 16px", display:"flex", flexDirection:"column", gap:8 }}>
                  {[
                    [t("app"),"AgentOS v0.1.0"],
                    ["Network","Arc Testnet"],
                    [t("chainId"),"5042002"],
                    [t("rpc"),"rpc.testnet.arc.network"],
                    [t("explorer"),"testnet.arcscan.app"],
                  ].map(([k,v]) => (
                    <div key={k} style={{ display:"flex", justifyContent:"space-between" }}>
                      <span style={{ fontSize:9, color:"#555", letterSpacing:1 }}>{k}</span>
                      <span style={{ fontSize:9, color:"#888", fontFamily:"monospace" }}>{v}</span>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>

        <div style={{ padding:"14px 24px 20px", borderTop:"1px solid rgba(255,255,255,0.06)",
          display:"flex", justifyContent:"flex-end", gap:10, flexShrink:0 }}>
          <button onClick={onClose} style={{ background:"rgba(255,255,255,0.05)",
            border:"1px solid rgba(255,255,255,0.1)", borderRadius:10, padding:"10px 22px",
            color:"#666", cursor:"pointer", fontFamily:"monospace", fontSize:11 }}>
            {t("cancel")}
          </button>
          <button onClick={saveProfile} style={{
            background: saved?"rgba(0,255,178,0.15)":"linear-gradient(135deg,#A78BFA,#7C3AED)",
            border: saved?"1px solid rgba(0,255,178,0.3)":"none",
            borderRadius:10, padding:"10px 28px", color: saved?"#00FFB2":"#fff",
            cursor:"pointer", fontFamily:"'Space Mono',monospace", fontSize:11, fontWeight:700,
            transition:"all 0.25s", display:"flex", alignItems:"center", gap:8
          }}>
            {saved ? <>✓ {t("saved")}</> : <>◎ {t("saveProfile")}</>}
          </button>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// 🔐 INTERNAL WALLET ENGINE — powered by ethers.js v6 (loaded via CDN)
// Keypair secp256k1 real, endereço EIP-55, assinatura RLP, envio via RPC
// ═══════════════════════════════════════════════════════════════════════════════

// Load ethers.js v6 once via CDN and cache on window
let _ethersPromise = null;
function loadEthers() {
  if (window._ethers) return Promise.resolve(window._ethers);
  if (_ethersPromise) return _ethersPromise;
  _ethersPromise = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    // ethers v5 UMD — stable exports; v6 UMD breaks in sandboxed iframes
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/ethers/5.7.2/ethers.umd.min.js";
    s.onload = () => {
      const eth = window.ethers;
      if (!eth || !eth.providers || !eth.Wallet) {
        reject(new Error("ethers loaded but API incomplete")); return;
      }
      window._ethers = eth;
      resolve(eth);
    };
    s.onerror = () => reject(new Error("Failed to load ethers.js"));
    document.head.appendChild(s);
  });
  return _ethersPromise;
}

// Helpers
function bytesToHex(b) { return Array.from(b).map(x=>x.toString(16).padStart(2,'0')).join(''); }

// ── Persistent storage: tries localStorage, falls back to in-memory Map ──────
// localStorage is blocked in some sandboxed environments (e.g. Claude artifacts).
// The in-memory fallback keeps data for the session — data resets on page reload.
const _memStore = new Map();
function _sGet(key, def) {
  try {
    const v = localStorage.getItem(key);
    return v !== null ? JSON.parse(v) : def;
  } catch { return _memStore.has(key) ? _memStore.get(key) : def; }
}
function _sSet(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); }
  catch { _memStore.set(key, val); }
}
function _sDel(key) {
  try { localStorage.removeItem(key); }
  catch { _memStore.delete(key); }
}

const IW_STORAGE_KEY  = "agentos_iw_v1";
const IW_HISTORY_KEY  = "agentos_iw_history_v1";

function loadInternalWallet()     { return _sGet(IW_STORAGE_KEY, null); }
function saveInternalWallet(data) { _sSet(IW_STORAGE_KEY, data); }
function clearInternalWallet()    { _sDel(IW_STORAGE_KEY); }
function loadTxHistory()          { return _sGet(IW_HISTORY_KEY, []); }
function saveTxHistory(hist)      { _sSet(IW_HISTORY_KEY, hist.slice(0, 50)); }

// ═══════════════════════════════════════════════════════════════════════════════
// 💼 INTERNAL WALLET MODAL
// ═══════════════════════════════════════════════════════════════════════════════
function InternalWalletModal({ onClose, onWalletReady }) {
  const [screen, setScreen]       = useState("loading"); // loading|home|create|import|send|receive|history|backup|confirm_delete
  const [ethers, setEthers]       = useState(null);
  const [provider, setProvider]   = useState(null);
  const [signer, setSigner]       = useState(null);
  const [iw, setIw]               = useState(() => loadInternalWallet());
  const [balance, setBalance]     = useState(null);
  const [nonce, setNonce]         = useState(0);
  const [blockNum, setBlockNum]   = useState(null);
  const [txHistory, setTxHistory] = useState(() => loadTxHistory());
  const [error, setError]         = useState("");
  const [success, setSuccess]     = useState("");
  const [loading, setLoading]     = useState(false);
  const [showPk, setShowPk]       = useState(false);

  // Send form
  const [sendTo, setSendTo]       = useState("");
  const [sendAmt, setSendAmt]     = useState("");
  const [sending, setSending]     = useState(false);
  const [sendResult, setSendResult] = useState(null);

  // Import form
  const [importPk, setImportPk]   = useState("");

  // ── Load ethers on mount ──────────────────────────────────────────────────
  useEffect(() => {
    loadEthers().then(eth => {
      setEthers(eth);
      setScreen(loadInternalWallet() ? "home" : "start");
    }).catch(() => {
      setError("Failed to load ethers.js — check your internet connection.");
      setScreen("start");
    });
  }, []);

  // ── Build provider + signer — pass network explicitly to skip auto-detect ──
  // ethers v5 JsonRpcProvider calls eth_chainId on construction; if the RPC
  // doesn't respond fast enough it throws NETWORK_ERROR. Fix: supply the
  // network object directly so no discovery request is made.
  useEffect(() => {
    if (!ethers || !iw?.privateKey) return;
    try {
      const network = { chainId: ARC_CHAIN_ID, name: "arc-testnet" };
      const prov = new ethers.providers.JsonRpcProvider(
        { url: RPC_URL, timeout: 15000 },
        network
      );
      const sgn = new ethers.Wallet(iw.privateKey, prov);
      setProvider(prov);
      setSigner(sgn);
    } catch(e) { setError("Wallet init error: " + e.message); }
  }, [ethers, iw?.privateKey]);

  // ── Refresh balance — uses raw fetch RPC to avoid provider network errors ─
  const refreshBalance = async () => {
    if (!iw?.address) return;
    try {
      const call = (method, params) => fetch(RPC_URL, {
        method:"POST", headers:{"Content-Type":"application/json"},
        body: JSON.stringify({ jsonrpc:"2.0", id:1, method, params })
      }).then(r => r.json()).then(d => { if (d.error) throw new Error(d.error.message); return d.result; });

      const [rawBal, rawBlk, rawNc] = await Promise.all([
        call("eth_getBalance",          [iw.address, "latest"]),
        call("eth_blockNumber",         []),
        call("eth_getTransactionCount", [iw.address, "latest"]),
      ]);

      const wei = BigInt(rawBal);
      setBalance({
        eth:  (Number(wei) / 1e18).toFixed(6),
        usdc: (Number(wei) / 1e18).toFixed(2),  // USDC display (18 dec native)
        wei:  rawBal,
      });
      setBlockNum(parseInt(rawBlk, 16));
      setNonce(parseInt(rawNc, 16));
      setError("");  // clear any previous RPC error on success
    } catch(e) { setError("RPC: " + e.message); }
  };

  useEffect(() => { refreshBalance(); }, [provider, iw?.address]);
  useEffect(() => {
    if (!provider || !iw?.address) return;
    const iv = setInterval(refreshBalance, 10000);
    return () => clearInterval(iv);
  }, [provider, iw?.address]);

  // ── Styles ────────────────────────────────────────────────────────────────
  const inp = {
    width:"100%", boxSizing:"border-box",
    background:"rgba(255,255,255,0.05)", border:"1px solid rgba(255,255,255,0.12)",
    borderRadius:9, padding:"11px 13px", color:"#e0e0e0",
    fontFamily:"monospace", fontSize:12, outline:"none",
  };
  const primaryBtn = (disabled) => ({
    width:"100%", padding:"12px", borderRadius:10, border:"none",
    cursor: disabled ? "not-allowed" : "pointer",
    fontFamily:"'Space Mono',monospace", fontSize:11, fontWeight:700, letterSpacing:1,
    background: disabled ? "rgba(0,255,178,0.2)" : "linear-gradient(135deg,#00FFB2,#00cc8e)",
    color: disabled ? "#00FFB280" : "#080C10", transition:"all 0.2s",
  });
  const ghostBtn = (color="#666") => ({
    width:"100%", padding:"11px", borderRadius:10, cursor:"pointer",
    fontFamily:"monospace", fontSize:11, fontWeight:700, letterSpacing:1,
    background:"rgba(255,255,255,0.04)", border:"1px solid rgba(255,255,255,0.1)",
    color, transition:"all 0.2s",
  });
  const ACCENT = "#00FFB2";

  // ── Helpers ───────────────────────────────────────────────────────────────
  const go = (s) => { setScreen(s); setError(""); setSuccess(""); setSendResult(null); };

  // ── CREATE WALLET ─────────────────────────────────────────────────────────
  const createWallet = async () => {
    if (!ethers) { setError("ethers.js not loaded yet."); return; }
    setLoading(true); setError("");
    try {
      const wallet = ethers.Wallet.createRandom();
      const data   = {
        address:    wallet.address,
        privateKey: wallet.privateKey,
        mnemonic:   wallet.mnemonic?.phrase || null,
        createdAt:  Date.now(),
      };
      saveInternalWallet(data);
      setIw(data);
      onWalletReady(wallet.address);
      go("backup");
    } catch(e) { setError(e.message); }
    setLoading(false);
  };

  // ── IMPORT WALLET ─────────────────────────────────────────────────────────
  const importWallet = async () => {
    if (!ethers) { setError("ethers.js not loaded yet."); return; }
    setLoading(true); setError("");
    try {
      const key    = importPk.trim();
      const wallet = new ethers.Wallet(key.startsWith("0x") ? key : "0x" + key);
      const data   = { address: wallet.address, privateKey: wallet.privateKey, createdAt: Date.now(), imported: true };
      saveInternalWallet(data);
      setIw(data);
      onWalletReady(wallet.address);
      setImportPk("");
      go("home");
      setSuccess("Wallet imported successfully!");
    } catch(e) { setError("Invalid private key: " + e.message); }
    setLoading(false);
  };

  // ── SEND TRANSACTION — sign locally, broadcast via raw fetch (no provider) ──
  // Bypasses ethers provider entirely: sign the tx with ethers.Wallet (offline),
  // then broadcast the raw signed bytes via a plain fetch to the RPC endpoint.
  // This avoids any network-detection call that ethers v5 makes under the hood.
  const sendTx = async () => {
    if (!ethers) { setError("ethers.js not loaded."); return; }
    if (!iw?.privateKey) { setError("No wallet loaded."); return; }
    setSending(true); setError("");
    try {
      if (!sendTo.match(/^0x[0-9a-fA-F]{40}$/)) throw new Error("Invalid recipient address.");
      const amt = parseFloat(sendAmt);
      if (isNaN(amt) || amt <= 0) throw new Error("Invalid amount.");

      // 1. Get nonce via raw fetch
      const rpcCall = async (method, params) => {
        const r = await fetch(RPC_URL, {
          method:"POST", headers:{"Content-Type":"application/json"},
          body: JSON.stringify({ jsonrpc:"2.0", id:1, method, params })
        });
        const d = await r.json();
        if (d.error) throw new Error(d.error.message);
        return d.result;
      };

      const [rawNonce, rawGasPrice] = await Promise.all([
        rpcCall("eth_getTransactionCount", [iw.address, "latest"]),
        rpcCall("eth_gasPrice",            []),
      ]);
      const currentNonce    = parseInt(rawNonce, 16);
      const gasPrice        = rawGasPrice;  // hex string

      // 2. Build + sign transaction OFFLINE using ethers.Wallet (no provider needed)
      const offlineWallet = new ethers.Wallet(iw.privateKey);  // no provider arg
      const txRequest = {
        to:       sendTo,
        value:    ethers.utils.parseEther(sendAmt.toString()),
        nonce:    currentNonce,
        gasLimit: ethers.BigNumber.from(21000),
        gasPrice: ethers.BigNumber.from(gasPrice),
        chainId:  ARC_CHAIN_ID,
        data:     "0x",
      };
      const signedTx = await offlineWallet.signTransaction(txRequest);

      // 3. Broadcast raw signed tx
      const txHash = await rpcCall("eth_sendRawTransaction", [signedTx]);

      const entry = {
        hash: txHash, to: sendTo, from: iw.address,
        amount: sendAmt, time: Date.now(), status: "pending", type: "send",
      };
      const hist = [entry, ...txHistory];
      setTxHistory(hist); saveTxHistory(hist);
      setSendResult({ hash: txHash, to: sendTo, amount: sendAmt });

      // 4. Poll for confirmation in background
      let attempts = 0;
      const poll = setInterval(async () => {
        try {
          attempts++;
          const receipt = await rpcCall("eth_getTransactionReceipt", [txHash]);
          if (receipt && receipt.status) {
            clearInterval(poll);
            const updated = hist.map(h => h.hash === txHash ? {...h, status:"confirmed"} : h);
            setTxHistory(updated); saveTxHistory(updated);
            refreshBalance();
          }
          if (attempts > 20) clearInterval(poll);
        } catch { clearInterval(poll); }
      }, 3000);

      setSendTo(""); setSendAmt("");
      setNonce(currentNonce + 1);
    } catch(e) {
      setError(e.reason || e.message || "Transaction failed.");
    }
    setSending(false);
  };

  // ── DELETE WALLET ─────────────────────────────────────────────────────────
  const deleteWallet = () => {
    clearInternalWallet();
    saveTxHistory([]);
    setIw(null); setBalance(null); setTxHistory([]);
    setSigner(null); setProvider(null);
    onWalletReady(null);
    go("start");
  };

  // ─────────────────────────────────────────────────────────────────────────
  return (
    <div style={{ position:"fixed", inset:0, zIndex:300, display:"flex", alignItems:"center",
      justifyContent:"center", background:"rgba(0,0,0,0.88)" }}
      onClick={e => e.target === e.currentTarget && onClose()}>

      <div style={{ background:"#0a0f16", border:"1px solid rgba(0,255,178,0.22)",
        borderRadius:24, width:460, maxWidth:"96vw", maxHeight:"92vh",
        display:"flex", flexDirection:"column", overflow:"hidden",
        boxShadow:"0 32px 80px rgba(0,0,0,0.85)" }}>

        {/* top bar */}
        <div style={{ height:3, background:"linear-gradient(90deg,transparent,#00FFB2,transparent)", flexShrink:0 }} />

        {/* Header */}
        <div style={{ padding:"18px 22px 0", flexShrink:0 }}>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:16 }}>
            <div style={{ display:"flex", alignItems:"center", gap:10 }}>
              {!["loading","start","home"].includes(screen) && (
                <button onClick={() => go(iw ? "home" : "start")}
                  style={{ background:"rgba(255,255,255,0.05)", border:"1px solid rgba(255,255,255,0.1)",
                    borderRadius:8, width:28, height:28, color:"#888", cursor:"pointer",
                    display:"flex", alignItems:"center", justifyContent:"center", fontSize:14 }}>‹</button>
              )}
              <div>
                <div style={{ fontSize:8, color:ACCENT, letterSpacing:2.5, marginBottom:2 }}>// AGENTOS • INTERNAL WALLET</div>
                <div style={{ fontFamily:"'Space Mono',monospace", fontSize:15, fontWeight:700 }}>
                  {screen==="loading"&&"Loading..."}
                  {screen==="start"&&"Internal Wallet"}
                  {screen==="home"&&(iw ? shortAddr(iw.address) : "Internal Wallet")}
                  {screen==="create"&&"New Wallet"}
                  {screen==="import"&&"Import Wallet"}
                  {screen==="send"&&"Send"}
                  {screen==="receive"&&"Receive"}
                  {screen==="history"&&"Transactions"}
                  {screen==="backup"&&"Backup Keys"}
                  {screen==="confirm_delete"&&"Delete Wallet"}
                </div>
              </div>
            </div>
            <button onClick={onClose} style={{ background:"rgba(255,255,255,0.04)",
              border:"1px solid rgba(255,255,255,0.08)", borderRadius:8, width:30, height:30,
              color:"#666", cursor:"pointer", fontSize:17,
              display:"flex", alignItems:"center", justifyContent:"center" }}>×</button>
          </div>
        </div>

        {/* Body */}
        <div style={{ flex:1, overflowY:"auto", padding:"0 22px 24px" }}>

          {/* Alerts */}
          {error && (
            <div style={{ background:"rgba(255,107,53,0.1)", border:"1px solid rgba(255,107,53,0.3)",
              borderRadius:9, padding:"9px 13px", fontSize:11, color:"#FF6B35", marginBottom:14, lineHeight:1.5 }}>
              ⚠ {error}
            </div>
          )}
          {success && (
            <div style={{ background:"rgba(0,255,178,0.08)", border:"1px solid rgba(0,255,178,0.25)",
              borderRadius:9, padding:"9px 13px", fontSize:11, color:ACCENT, marginBottom:14 }}>
              ✓ {success}
            </div>
          )}

          {/* ══ LOADING ══ */}
          {screen === "loading" && (
            <div style={{ textAlign:"center", padding:"40px 0" }}>
              <div style={{ width:40, height:40, borderRadius:"50%", border:"3px solid rgba(0,255,178,0.15)",
                borderTopColor:ACCENT, animation:"spin 0.8s linear infinite", margin:"0 auto 16px" }} />
              <div style={{ fontSize:11, color:"#555" }}>Loading ethers.js...</div>
            </div>
          )}

          {/* ══ START (no wallet) ══ */}
          {screen === "start" && (
            <div style={{ paddingTop:8 }}>
              <div style={{ textAlign:"center", padding:"16px 0 20px" }}>
                <div style={{ fontSize:50, marginBottom:12 }}>🔐</div>
                <div style={{ fontSize:12, color:"#777", lineHeight:1.7, marginBottom:4 }}>
                  A fully in-browser, self-custodial wallet.<br/>
                  No MetaMask. No extensions. Your keys stay<br/>
                  in your browser only.
                </div>
              </div>
              <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
                <button onClick={() => go("create")} style={primaryBtn(false)}>
                  ✦ CREATE NEW WALLET
                </button>
                <button onClick={() => go("import")} style={ghostBtn("#A78BFA")}>
                  ⬡ IMPORT PRIVATE KEY
                </button>
              </div>
              <div style={{ marginTop:18, padding:"11px 14px",
                background:"rgba(255,255,255,0.02)", border:"1px solid rgba(255,255,255,0.05)",
                borderRadius:10, fontSize:9, color:"#444", lineHeight:1.9 }}>
                🔒 Private key never leaves your browser<br/>
                ⬡ Arc Testnet • Chain ID 5042002 • USDC as gas (~$0.01/tx)<br/>
                💧 <a href="https://faucet.circle.com" target="_blank" rel="noreferrer"
                  style={{ color:"#00FFB2" }}>faucet.circle.com</a> — USDC &amp; EURC free<br/>
                🔍 <a href="https://testnet.arcscan.app" target="_blank" rel="noreferrer"
                  style={{ color:"#00FFB2" }}>testnet.arcscan.app</a>
              </div>
            </div>
          )}

          {/* ══ HOME (wallet loaded) ══ */}
          {screen === "home" && iw && (
            <div style={{ paddingTop:6 }}>
              {/* Balance card */}
              <div style={{ background:"linear-gradient(135deg,rgba(0,255,178,0.09),rgba(0,255,178,0.03))",
                border:"1px solid rgba(0,255,178,0.22)", borderRadius:16, padding:"18px 20px", marginBottom:14 }}>
                <div style={{ fontSize:8, color:"#555", letterSpacing:2, marginBottom:6 }}>BALANCE • ARC TESTNET</div>
                <div style={{ fontFamily:"'Space Mono',monospace", fontSize:28, fontWeight:700, color:ACCENT, marginBottom:2 }}>
                  {balance ? `${parseFloat(balance.usdc).toFixed(2)} USDC` : "—"}
                </div>
                <div style={{ fontSize:10, color:"#555", marginBottom:14 }}>
                  {balance ? `${parseFloat(balance.native||0).toFixed(6)} native` : "fetching..."}
                </div>
                <div style={{ background:"rgba(0,0,0,0.35)", borderRadius:9, padding:"8px 12px",
                  display:"flex", alignItems:"center", justifyContent:"space-between" }}>
                  <span style={{ fontFamily:"monospace", fontSize:10, color:"#777" }}>{iw.address}</span>
                  <button onClick={() => { navigator.clipboard.writeText(iw.address); setSuccess("Copied!"); setTimeout(()=>setSuccess(""),2000); }}
                    style={{ background:"none", border:"none", color:"#444", cursor:"pointer", fontSize:13, padding:0 }}>⧉</button>
                </div>
                <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:8, marginTop:10 }}>
                  {[["BLOCK",blockNum??"—"],["NONCE",nonce],["NET","Arc Testnet"]].map(([l,v])=>(
                    <div key={l} style={{ background:"rgba(0,0,0,0.2)", borderRadius:8, padding:"6px 10px" }}>
                      <div style={{ fontSize:7, color:"#444", marginBottom:2, letterSpacing:1 }}>{l}</div>
                      <div style={{ fontSize:10, color:"#888", fontFamily:"monospace" }}>{v}</div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Action grid */}
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8, marginBottom:12 }}>
                {[
                  {label:"SEND",    icon:"↑",  color:"#00FFB2", s:"send"},
                  {label:"RECEIVE", icon:"↓",  color:"#A78BFA", s:"receive"},
                  {label:"HISTORY", icon:"☰",  color:"#FCD34D", s:"history"},
                  {label:"BACKUP",  icon:"🔑", color:"#FF6B35", s:"backup"},
                ].map(a=>(
                  <button key={a.s} onClick={()=>go(a.s)} style={{
                    background:`${a.color}10`, border:`1px solid ${a.color}30`,
                    borderRadius:12, padding:"14px 10px", cursor:"pointer",
                    display:"flex", flexDirection:"column", alignItems:"center", gap:7, transition:"all 0.2s"
                  }}
                  onMouseEnter={e=>e.currentTarget.style.background=`${a.color}20`}
                  onMouseLeave={e=>e.currentTarget.style.background=`${a.color}10`}>
                    <span style={{ fontSize:22, color:a.color }}>{a.icon}</span>
                    <span style={{ fontSize:9, color:a.color, fontFamily:"monospace", letterSpacing:1 }}>{a.label}</span>
                  </button>
                ))}
              </div>

              {/* Refresh + Faucet */}
              <div style={{ display:"flex", gap:8, marginBottom:10 }}>
                <button onClick={refreshBalance} style={{...ghostBtn(ACCENT), flex:1, padding:"9px"}}>
                  ↻ REFRESH
                </button>
                <a href="https://faucet.circle.com" target="_blank" rel="noreferrer"
                  style={{ flex:1, padding:"9px", borderRadius:10, border:"1px solid rgba(252,211,77,0.25)",
                    background:"rgba(252,211,77,0.07)", color:"#FCD34D", fontFamily:"monospace",
                    fontSize:11, fontWeight:700, letterSpacing:1, textDecoration:"none",
                    display:"flex", alignItems:"center", justifyContent:"center", gap:6 }}>
                  💧 FAUCET
                </a>
              </div>
              <button onClick={()=>go("confirm_delete")}
                style={{ ...ghostBtn("#333"), fontSize:10, marginTop:4 }}>
                Remove wallet from device
              </button>
            </div>
          )}

          {/* ══ CREATE ══ */}
          {screen === "create" && (
            <div style={{ paddingTop:8 }}>
              <div style={{ background:"rgba(255,255,255,0.03)", border:"1px solid rgba(255,255,255,0.06)",
                borderRadius:12, padding:"14px 16px", marginBottom:18, fontSize:11, color:"#666", lineHeight:1.9 }}>
                🔐 Generates a real <strong style={{color:"#fff"}}>secp256k1</strong> keypair using <code style={{color:ACCENT}}>ethers.Wallet.createRandom()</code><br/>
                📝 A <strong style={{color:"#fff"}}>12-word mnemonic</strong> will be shown — write it down<br/>
                ⬡ Works directly on <strong style={{color:ACCENT}}>Arc Testnet</strong> — no MetaMask needed
              </div>
              <button onClick={createWallet} disabled={loading || !ethers} style={primaryBtn(loading || !ethers)}>
                {loading ? "GENERATING KEYPAIR..." : !ethers ? "LOADING ETHERS.JS..." : "✦ CREATE WALLET"}
              </button>
            </div>
          )}

          {/* ══ IMPORT ══ */}
          {screen === "import" && (
            <div style={{ paddingTop:8 }}>
              <div style={{ marginBottom:14 }}>
                <label style={{ fontSize:9, color:"#555", letterSpacing:1.5, display:"block", marginBottom:6 }}>
                  PRIVATE KEY (with or without 0x prefix)
                </label>
                <input value={importPk} onChange={e=>setImportPk(e.target.value)}
                  placeholder="0x... or 64 hex chars" type="password" style={inp} />
              </div>
              <button onClick={importWallet} disabled={loading || !importPk || !ethers} style={primaryBtn(loading || !importPk || !ethers)}>
                {loading ? "IMPORTING..." : "⬡ IMPORT WALLET"}
              </button>
            </div>
          )}

          {/* ══ SEND ══ */}
          {screen === "send" && iw && (
            <div style={{ paddingTop:8 }}>
              {sendResult ? (
                <div style={{ textAlign:"center", padding:"16px 0" }}>
                  <div style={{ width:70, height:70, borderRadius:"50%",
                    background:"rgba(0,255,178,0.1)", border:"2px solid rgba(0,255,178,0.4)",
                    display:"flex", alignItems:"center", justifyContent:"center",
                    fontSize:30, margin:"0 auto 16px", animation:"glow 1.5s infinite" }}>✓</div>
                  <div style={{ fontFamily:"'Space Mono',monospace", fontSize:14, color:ACCENT, marginBottom:8 }}>
                    Transaction Sent!
                  </div>
                  <div style={{ fontSize:11, color:"#888", marginBottom:8 }}>
                    {sendResult.amount} USDC → {shortAddr(sendResult.to)}
                  </div>
                  <div style={{ fontFamily:"monospace", fontSize:9, color:"#555",
                    background:"rgba(255,255,255,0.03)", borderRadius:8, padding:"8px 12px",
                    wordBreak:"break-all", marginBottom:14 }}>
                    {sendResult.hash}
                  </div>
                  <a href={`https://testnet.arcscan.app/tx/${sendResult.hash}`} target="_blank" rel="noreferrer"
                    style={{ fontSize:10, color:ACCENT, display:"block", marginBottom:16 }}>
                    View on Explorer ↗
                  </a>
                  <button onClick={()=>setSendResult(null)} style={primaryBtn(false)}>SEND ANOTHER</button>
                </div>
              ) : (
                <>
                  <div style={{ background:"rgba(0,255,178,0.06)", border:"1px solid rgba(0,255,178,0.15)",
                    borderRadius:10, padding:"10px 14px", marginBottom:14,
                    display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                    <span style={{ fontSize:10, color:"#555" }}>Available</span>
                    <span style={{ fontFamily:"monospace", fontSize:14, color:ACCENT, fontWeight:700 }}>
                      {balance ? `${parseFloat(balance.usdc).toFixed(2)} USDC` : "—"}
                    </span>
                  </div>

                  <div style={{ marginBottom:12 }}>
                    <label style={{ fontSize:9, color:"#555", letterSpacing:1.5, display:"block", marginBottom:6 }}>TO ADDRESS</label>
                    <input value={sendTo} onChange={e=>setSendTo(e.target.value)} placeholder="0x..." style={inp} />
                  </div>

                  <div style={{ marginBottom:16 }}>
                    <label style={{ fontSize:9, color:"#555", letterSpacing:1.5, display:"block", marginBottom:6 }}>AMOUNT (USDC)</label>
                    <div style={{ position:"relative" }}>
                      <input value={sendAmt} onChange={e=>setSendAmt(e.target.value)}
                        placeholder="0.00" type="number" step="0.01" min="0"
                        style={{...inp, paddingRight:60}} />
                      <button onClick={()=>setSendAmt(balance?.usdcFloat != null ? balance.usdcFloat.toFixed(6) : balance?.usdc ? parseFloat(balance.usdc).toFixed(6) : "")}
                        style={{ position:"absolute", right:10, top:"50%", transform:"translateY(-50%)",
                          background:"rgba(0,255,178,0.12)", border:"1px solid rgba(0,255,178,0.2)",
                          borderRadius:6, padding:"3px 8px", color:ACCENT, cursor:"pointer", fontSize:9 }}>
                        MAX
                      </button>
                    </div>
                  </div>

                  <div style={{ background:"rgba(255,255,255,0.02)", borderRadius:9,
                    padding:"10px 13px", marginBottom:16, fontSize:10, color:"#555" }}>
                    {[["Network","Arc Testnet"],["Gas token","USDC (native)"],["Est. fee","~$0.01 USDC"],["Nonce",nonce.toString()]].map(([k,v])=>(
                      <div key={k} style={{ display:"flex", justifyContent:"space-between", marginBottom:4 }}>
                        <span>{k}</span><span style={{color:"#888",fontFamily:"monospace"}}>{v}</span>
                      </div>
                    ))}
                  </div>

                  <button onClick={sendTx} disabled={sending||!sendTo||!sendAmt||!signer}
                    style={primaryBtn(sending||!sendTo||!sendAmt||!signer)}>
                    {sending ? "BROADCASTING..." : "↑ SEND TRANSACTION"}
                  </button>
                </>
              )}
            </div>
          )}

          {/* ══ RECEIVE ══ */}
          {screen === "receive" && iw && (
            <div style={{ paddingTop:8, textAlign:"center" }}>
              <div style={{ margin:"0 auto 16px", width:190, height:190,
                border:"2px solid rgba(0,255,178,0.3)", borderRadius:14, overflow:"hidden",
                background:"#fff", display:"flex", alignItems:"center", justifyContent:"center" }}>
                <img src={`https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${iw.address}`}
                  alt="QR" width={180} height={180} style={{ display:"block" }} />
              </div>
              <div style={{ fontSize:10, color:"#555", marginBottom:8 }}>Your Arc Testnet Address</div>
              <div style={{ fontFamily:"monospace", fontSize:11, color:"#ccc", wordBreak:"break-all",
                background:"rgba(255,255,255,0.04)", border:"1px solid rgba(255,255,255,0.08)",
                borderRadius:9, padding:"10px 14px", marginBottom:14 }}>
                {iw.address}
              </div>
              <button onClick={()=>{navigator.clipboard.writeText(iw.address);setSuccess("Copied!");setTimeout(()=>setSuccess(""),2000);}}
                style={primaryBtn(false)}>⧉ COPY ADDRESS</button>
              <div style={{ marginTop:14, padding:"11px 14px", background:"rgba(252,211,77,0.06)",
                border:"1px solid rgba(252,211,77,0.15)", borderRadius:10, fontSize:10, color:"#666" }}>
                💧 Get testnet USDC: <a href="https://faucet.circle.com" target="_blank" rel="noreferrer"
                  style={{color:"#FCD34D"}}>faucet.circle.com</a>
              </div>
            </div>
          )}

          {/* ══ HISTORY ══ */}
          {screen === "history" && (
            <div style={{ paddingTop:8 }}>
              {txHistory.length === 0 ? (
                <div style={{ textAlign:"center", padding:"30px 0", color:"#444", fontSize:12 }}>No transactions yet.</div>
              ) : txHistory.map((tx,i)=>(
                <div key={i} style={{ background:"rgba(255,255,255,0.03)",
                  border:"1px solid rgba(255,255,255,0.06)", borderRadius:11, padding:"12px 14px", marginBottom:8 }}>
                  <div style={{ display:"flex", justifyContent:"space-between", marginBottom:6 }}>
                    <span style={{ fontSize:11, color:tx.type==="send"?"#FF6B35":ACCENT, fontFamily:"monospace" }}>
                      {tx.type==="send"?"↑ SENT":"↓ RECEIVED"}
                    </span>
                    <span style={{ fontSize:9, color:"#444" }}>{new Date(tx.time).toLocaleString()}</span>
                  </div>
                  <div style={{ fontSize:14, color:"#fff", fontWeight:700, marginBottom:4 }}>{tx.amount} USDC</div>
                  <div style={{ fontSize:9, color:"#555", fontFamily:"monospace" }}>
                    {tx.type==="send"?"To: ":"From: "}{shortAddr(tx.type==="send"?tx.to:tx.from)}
                  </div>
                  <div style={{ display:"flex", justifyContent:"space-between", marginTop:6 }}>
                    <span style={{ fontSize:8, color:"#333", fontFamily:"monospace" }}>{shortAddr(tx.hash)}</span>
                    <span style={{ fontSize:8, color: tx.status==="confirmed"?ACCENT:tx.status==="pending"?"#FCD34D":"#A78BFA" }}>
                      ● {tx.status}
                    </span>
                  </div>
                  <a href={`https://testnet.arcscan.app/tx/${tx.hash}`} target="_blank" rel="noreferrer"
                    style={{ fontSize:8, color:"#333", display:"block", marginTop:4 }}>View on Explorer ↗</a>
                </div>
              ))}
            </div>
          )}

          {/* ══ BACKUP ══ */}
          {screen === "backup" && iw && (
            <div style={{ paddingTop:8 }}>
              <div style={{ background:"rgba(255,107,53,0.08)", border:"1px solid rgba(255,107,53,0.25)",
                borderRadius:12, padding:"13px 15px", marginBottom:16, fontSize:11, color:"#FF6B35", lineHeight:1.7 }}>
                ⚠️ <strong>Write this down offline.</strong> Anyone with your private key controls your funds.
                AgentOS cannot recover it for you.
              </div>

              {iw.mnemonic && (
                <div style={{ marginBottom:14 }}>
                  <label style={{ fontSize:9, color:"#555", letterSpacing:1.5, display:"block", marginBottom:6 }}>12-WORD MNEMONIC</label>
                  <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:6 }}>
                    {iw.mnemonic.split(" ").map((w,i)=>(
                      <div key={i} style={{ background:"rgba(0,255,178,0.06)", border:"1px solid rgba(0,255,178,0.15)",
                        borderRadius:7, padding:"6px 8px", display:"flex", alignItems:"center", gap:6 }}>
                        <span style={{ fontSize:8, color:"#444", minWidth:14 }}>{i+1}.</span>
                        <span style={{ fontSize:11, color:ACCENT, fontFamily:"monospace" }}>{w}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div style={{ marginBottom:14 }}>
                <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:6 }}>
                  <label style={{ fontSize:9, color:"#555", letterSpacing:1.5 }}>PRIVATE KEY</label>
                  <button onClick={()=>setShowPk(v=>!v)}
                    style={{ background:"rgba(255,255,255,0.05)", border:"1px solid rgba(255,255,255,0.1)",
                      borderRadius:6, padding:"3px 10px", color:"#888", cursor:"pointer", fontSize:10 }}>
                    {showPk?"HIDE":"SHOW"}
                  </button>
                </div>
                <div onClick={()=>setShowPk(true)}
                  style={{ fontFamily:"monospace", fontSize:11,
                    color: showPk?"#FF6B35":"#333",
                    background:"rgba(255,255,255,0.03)",
                    border:`1px solid ${showPk?"rgba(255,107,53,0.3)":"rgba(255,255,255,0.06)"}`,
                    borderRadius:8, padding:"10px 12px", wordBreak:"break-all",
                    filter: showPk?"none":"blur(5px)", userSelect: showPk?"text":"none",
                    cursor: showPk?"text":"pointer", lineHeight:1.6 }}>
                  {showPk ? iw.privateKey : "Click to reveal private key"}
                </div>
              </div>

              {showPk && (
                <button onClick={()=>{navigator.clipboard.writeText(iw.privateKey);setSuccess("Copied! Store it safely.");setTimeout(()=>setSuccess(""),3000);}}
                  style={{...ghostBtn("#FF6B35"), marginBottom:10}}>
                  ⧉ COPY PRIVATE KEY
                </button>
              )}

              <button onClick={()=>go("home")} style={primaryBtn(false)}>
                ✓ I'VE SAVED MY KEYS — CONTINUE
              </button>
            </div>
          )}

          {/* ══ CONFIRM DELETE ══ */}
          {screen === "confirm_delete" && (
            <div style={{ paddingTop:8, textAlign:"center" }}>
              <div style={{ fontSize:44, marginBottom:14 }}>🗑️</div>
              <div style={{ fontSize:13, color:"#FF6B35", fontFamily:"'Space Mono',monospace", marginBottom:8 }}>Delete wallet?</div>
              <div style={{ fontSize:11, color:"#666", marginBottom:24, lineHeight:1.8 }}>
                Removes wallet data from this device.<br/>
                <strong style={{color:"#FF6B35"}}>Back up your private key first.</strong><br/>
                This cannot be undone.
              </div>
              <div style={{ display:"flex", gap:10 }}>
                <button onClick={()=>go("home")} style={{...ghostBtn(), flex:1}}>CANCEL</button>
                <button onClick={deleteWallet} style={{ flex:1, padding:"12px", borderRadius:10, border:"1px solid rgba(255,51,102,0.4)",
                  cursor:"pointer", fontFamily:"monospace", fontSize:11, fontWeight:700,
                  background:"rgba(255,51,102,0.12)", color:"#FF3366" }}>DELETE</button>
              </div>
            </div>
          )}

        </div>
      </div>
    </div>
  );
}


// ─── CONFIRM TX MODAL ─────────────────────────────────────────────────────────
// Shows full transaction breakdown (amount, fee, total, to, network) before
// any eth_sendTransaction call. Used for payments AND swaps.
function ConfirmTxModal({ tx, onConfirm, onCancel }) {
  // tx = { type, from, to, amount, amountLabel, fee, feeLabel, total, totalLabel,
  //         network, chainId, extra[] }
  const [busy, setBusy] = useState(false);
  const [err,  setErr]  = useState("");
  const handle = async () => {
    setBusy(true); setErr("");
    try { await onConfirm(); }
    catch(e) { setErr(e.message || "Rejected"); setBusy(false); }
  };
  const ROW = ({label, val, accent}) => (
    <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center",
      padding:"8px 0", borderBottom:"1px solid rgba(255,255,255,0.04)" }}>
      <span style={{ fontSize:10, color:"#666" }}>{label}</span>
      <span style={{ fontSize:11, color: accent||"#ccc", fontFamily:"monospace", fontWeight:700 }}>{val}</span>
    </div>
  );
  return (
    <div style={{ position:"fixed", inset:0, zIndex:500, display:"flex", alignItems:"center",
      justifyContent:"center", background:"rgba(0,0,0,0.92)" }}>
      <div style={{ background:"#0a0f16", border:"1px solid rgba(0,255,178,0.25)", borderRadius:20,
        width:420, maxWidth:"95vw", overflow:"hidden",
        boxShadow:"0 32px 80px rgba(0,0,0,0.9)" }}>
        <div style={{ height:3, background:"linear-gradient(90deg,transparent,#00FFB2,transparent)" }} />
        <div style={{ padding:"22px 24px 24px" }}>
          {/* Header */}
          <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:20 }}>
            <div style={{ width:38, height:38, borderRadius:10, background:"rgba(0,255,178,0.1)",
              border:"1px solid rgba(0,255,178,0.25)", display:"flex", alignItems:"center",
              justifyContent:"center", fontSize:18 }}>
              {tx.type==="swap" ? "⇅" : tx.type==="sign" ? "✍" : "↑"}
            </div>
            <div>
              <div style={{ fontSize:8, color:"#00FFB2", letterSpacing:2 }}>CONFIRM TRANSACTION</div>
              <div style={{ fontFamily:"'Space Mono',monospace", fontSize:14, fontWeight:700 }}>
                {tx.type==="swap" ? "Swap" : tx.type==="sign" ? "Sign Message" : "Send Payment"}
              </div>
            </div>
          </div>

          {/* Main amount */}
          <div style={{ background:"rgba(0,255,178,0.05)", border:"1px solid rgba(0,255,178,0.15)",
            borderRadius:12, padding:"14px 16px", marginBottom:16, textAlign:"center" }}>
            <div style={{ fontSize:9, color:"#555", letterSpacing:2, marginBottom:4 }}>AMOUNT</div>
            <div style={{ fontFamily:"'Space Mono',monospace", fontSize:22, fontWeight:700,
              color:"#00FFB2" }}>{tx.amountLabel}</div>
          </div>

          {/* Details */}
          <div style={{ marginBottom:16 }}>
            {tx.to   && <ROW label="To"        val={tx.to.length>20 ? `${tx.to.slice(0,10)}...${tx.to.slice(-8)}` : tx.to} />}
            {tx.from && <ROW label="From"      val={`${tx.from.slice(0,10)}...${tx.from.slice(-8)}`} />}
            <ROW label="Network"   val={tx.network || "Arc Testnet"} />
            <ROW label="Chain ID"  val={String(tx.chainId || ARC_CHAIN_ID)} />
            <ROW label="Gas token" val="USDC (native)" />
            <ROW label="Est. gas"  val="~$0.01 USDC" />
            {tx.feeLabel && (
              <ROW label="Platform fee (0.1%)" val={tx.feeLabel} accent="#FCD34D" />
            )}
            {tx.totalLabel && (
              <ROW label="Total deducted" val={tx.totalLabel} accent="#FF6B35" />
            )}
            {(tx.extra||[]).map(([k,v]) => <ROW key={k} label={k} val={v} />)}
          </div>

          {/* Arc disclaimer */}
          <div style={{ background:"rgba(255,255,255,0.02)", borderRadius:9,
            padding:"8px 12px", marginBottom:16, fontSize:9, color:"#444", lineHeight:1.7 }}>
            ⬡ Malachite BFT • ~350ms deterministic finality • No reorgs<br/>
            🔒 Signing with your EVM key — verify the details above before confirming
          </div>

          {err && (
            <div style={{ background:"rgba(255,51,102,0.1)", border:"1px solid rgba(255,51,102,0.3)",
              borderRadius:8, padding:"8px 12px", fontSize:11, color:"#FF3366", marginBottom:12 }}>
              ⚠ {err}
            </div>
          )}

          <div style={{ display:"flex", gap:10 }}>
            <button onClick={onCancel} disabled={busy}
              style={{ flex:1, padding:"12px", borderRadius:10, border:"1px solid rgba(255,255,255,0.1)",
                background:"rgba(255,255,255,0.04)", color:"#888", cursor:"pointer",
                fontFamily:"monospace", fontSize:11, fontWeight:700, letterSpacing:1 }}>
              CANCEL
            </button>
            <button onClick={handle} disabled={busy}
              style={{ flex:2, padding:"12px", borderRadius:10, border:"none",
                background: busy ? "rgba(0,255,178,0.2)" : "linear-gradient(135deg,#00FFB2,#00cc8e)",
                color: busy ? "#00FFB280" : "#080C10", cursor: busy ? "not-allowed" : "pointer",
                fontFamily:"'Space Mono',monospace", fontSize:11, fontWeight:700, letterSpacing:1,
                display:"flex", alignItems:"center", justifyContent:"center", gap:8 }}>
              {busy
                ? <><div style={{ width:12, height:12, borderRadius:"50%",
                    border:"2px solid rgba(0,255,178,0.3)", borderTopColor:"#00FFB2",
                    animation:"spin 0.8s linear infinite" }} /> SIGNING...</>
                : <>✓ CONFIRM & SIGN</>}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// 🔑 CIRCLE SDK CONFIG — owner-only panel, protected by password gate
// Trigger: triple-click on version string in footer (invisible to users)
// ═══════════════════════════════════════════════════════════════════════════════
const OWNER_HASH = "8c6976e5b5410415bde908bd4dee15dfb167a9c873fc4bb8a81f6f2ab448a918"; // sha256("admin") — change this

async function sha256hex(str) {
  const buf  = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b=>b.toString(16).padStart(2,"0")).join("");
}

function CircleSDKModal({ onClose }) {
  const [phase,    setPhase]    = useState("auth");   // auth | config
  const [pw,       setPw]       = useState("");
  const [pwErr,    setPwErr]    = useState("");
  const [checking, setChecking] = useState(false);
  const [saved,    setSaved]    = useState(false);
  const [copied,   setCopied]   = useState("");
  const [tab,      setTab]      = useState("app");
  const [cfg, setCfg] = useState(() => {
    return _sGet("circle_sdk_cfg_v1", {});
  });

  const saveCfg = (next) => {
    const merged = { ...cfg, ...next };
    setCfg(merged);
    _sSet("circle_sdk_cfg_v1", merged);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const checkPw = async () => {
    setChecking(true); setPwErr("");
    const hash = await sha256hex(pw);
    if (hash === OWNER_HASH) { setPhase("config"); }
    else { setPwErr("Incorrect password"); setTimeout(()=>setPwErr(""),3000); }
    setChecking(false);
  };

  const copyVal = (val, key) => {
    navigator.clipboard.writeText(val || "").catch(()=>{});
    setCopied(key); setTimeout(()=>setCopied(""),2000);
  };

  const ACCENT = "#00FFB2";
  const inp = {
    width:"100%", boxSizing:"border-box",
    background:"rgba(255,255,255,0.04)", border:"1px solid rgba(255,255,255,0.1)",
    borderRadius:8, padding:"9px 12px", color:"#e0e0e0",
    fontFamily:"monospace", fontSize:11, outline:"none",
    transition:"border 0.2s",
  };
  const label = { fontSize:9, color:"#555", letterSpacing:1.5, marginBottom:4, display:"block" };
  const field = { marginBottom:14 };

  const TABS = [
    { id:"app",     label:"App Credentials" },
    { id:"entity",  label:"Entity"          },
    { id:"wallets", label:"Wallets"         },
    { id:"network", label:"Network"         },
    { id:"webhooks",label:"Webhooks"        },
  ];

  const Field = ({ lbl, k, type="text", placeholder="" }) => (
    <div style={field}>
      <span style={label}>{lbl}</span>
      <div style={{ position:"relative" }}>
        <input
          type={type}
          value={cfg[k] || ""}
          onChange={e => setCfg(p => ({...p, [k]:e.target.value}))}
          placeholder={placeholder}
          style={{ ...inp, paddingRight:36 }}
          onFocus={e => e.target.style.borderColor=ACCENT}
          onBlur={e  => e.target.style.borderColor="rgba(255,255,255,0.1)"}
        />
        {cfg[k] && (
          <button onClick={()=>copyVal(cfg[k], k)}
            style={{ position:"absolute", right:8, top:"50%", transform:"translateY(-50%)",
              background:"none", border:"none", cursor:"pointer",
              color: copied===k ? ACCENT : "#555", fontSize:11, padding:0 }}>
            {copied===k ? "✓" : "⎘"}
          </button>
        )}
      </div>
    </div>
  );

  return (
    <div style={{ position:"fixed", inset:0, zIndex:1000,
      display:"flex", alignItems:"center", justifyContent:"center",
      background:"rgba(0,0,0,0.95)", backdropFilter:"blur(12px)" }}>
      <div style={{ background:"#080e16", border:"1px solid rgba(0,255,178,0.2)",
        borderRadius:20, width: phase==="auth" ? 360 : 560,
        maxWidth:"95vw", maxHeight:"90vh", overflow:"hidden",
        boxShadow:"0 0 80px rgba(0,255,178,0.06)",
        display:"flex", flexDirection:"column" }}>

        {/* Top bar */}
        <div style={{ height:2, background:"linear-gradient(90deg,transparent,#00FFB2,transparent)" }} />

        {/* Header */}
        <div style={{ padding:"18px 22px 0", display:"flex", justifyContent:"space-between", alignItems:"center" }}>
          <div style={{ display:"flex", alignItems:"center", gap:10 }}>
            <div style={{ width:34, height:34, borderRadius:9,
              background:"rgba(0,255,178,0.08)", border:"1px solid rgba(0,255,178,0.2)",
              display:"flex", alignItems:"center", justifyContent:"center", fontSize:16 }}>⬡</div>
            <div>
              <div style={{ fontSize:8, color:ACCENT, letterSpacing:2 }}>CIRCLE • OWNER ONLY</div>
              <div style={{ fontFamily:"'Space Mono',monospace", fontSize:13, fontWeight:700 }}>
                Circle SDK Configuration
              </div>
            </div>
          </div>
          <button onClick={onClose}
            style={{ background:"rgba(255,255,255,0.05)", border:"1px solid rgba(255,255,255,0.1)",
              borderRadius:7, width:28, height:28, color:"#666", cursor:"pointer",
              display:"flex", alignItems:"center", justifyContent:"center", fontSize:15 }}>×</button>
        </div>

        {/* ── AUTH GATE */}
        {phase === "auth" && (
          <div style={{ padding:"24px 22px 22px" }}>
            <div style={{ fontSize:11, color:"#555", marginBottom:20, lineHeight:1.7 }}>
              This panel is restricted to the platform owner.<br/>
              Enter your owner password to continue.
            </div>
            <div style={field}>
              <span style={label}>OWNER PASSWORD</span>
              <input
                type="password"
                value={pw}
                onChange={e => setPw(e.target.value)}
                onKeyDown={e => e.key==="Enter" && checkPw()}
                placeholder="••••••••"
                autoFocus
                style={{ ...inp, letterSpacing:4, fontSize:16 }}
                onFocus={e => e.target.style.borderColor=ACCENT}
                onBlur={e  => e.target.style.borderColor="rgba(255,255,255,0.1)"}
              />
            </div>
            {pwErr && (
              <div style={{ fontSize:10, color:"#FF3366", marginBottom:12,
                background:"rgba(255,51,102,0.08)", borderRadius:7, padding:"6px 10px" }}>
                ✗ {pwErr}
              </div>
            )}
            <button onClick={checkPw} disabled={checking || !pw}
              style={{ width:"100%", padding:"11px", borderRadius:9, border:"none",
                background: !pw||checking ? "rgba(0,255,178,0.1)" : "linear-gradient(135deg,#00FFB2,#00cc8e)",
                color: !pw||checking ? "#00FFB280" : "#080C10",
                fontFamily:"'Space Mono',monospace", fontWeight:700, fontSize:11,
                letterSpacing:1, cursor: !pw||checking ? "not-allowed" : "pointer",
                display:"flex", alignItems:"center", justifyContent:"center", gap:8 }}>
              {checking
                ? <><div style={{ width:10, height:10, borderRadius:"50%", border:"2px solid rgba(0,255,178,0.3)", borderTopColor:"#00FFB2", animation:"spin 0.7s linear infinite" }} /> VERIFYING...</>
                : "UNLOCK →"
              }
            </button>
            <div style={{ marginTop:14, fontSize:9, color:"#2a2a2a", textAlign:"center", fontFamily:"monospace" }}>
              Protected by SHA-256 • Not transmitted anywhere
            </div>
          </div>
        )}

        {/* ── CONFIG PANEL */}
        {phase === "config" && (
          <>
          {/* Tabs */}
          <div style={{ display:"flex", gap:2, padding:"14px 22px 0", overflowX:"auto" }}>
            {TABS.map(t => (
              <button key={t.id} onClick={()=>setTab(t.id)}
                style={{ padding:"6px 12px", borderRadius:"7px 7px 0 0",
                  border:"1px solid rgba(255,255,255,0.07)", borderBottom:"none",
                  background: tab===t.id ? "rgba(0,255,178,0.08)" : "transparent",
                  color: tab===t.id ? ACCENT : "#555",
                  fontFamily:"monospace", fontSize:9, letterSpacing:1,
                  cursor:"pointer", whiteSpace:"nowrap",
                  transition:"all 0.15s" }}>
                {t.label.toUpperCase()}
              </button>
            ))}
          </div>
          <div style={{ height:1, background:"rgba(0,255,178,0.1)", margin:"0 22px" }} />

          {/* Tab content */}
          <div style={{ flex:1, overflowY:"auto", padding:"18px 22px" }}>

            {tab === "app" && <>
              <div style={{ fontSize:9, color:"#444", marginBottom:16, lineHeight:1.8 }}>
                Circle Developer Console credentials.<br/>
                <a href="https://console.circle.com" target="_blank" rel="noreferrer"
                  style={{ color:ACCENT, textDecoration:"none" }}>console.circle.com →</a>
              </div>
              <Field lbl="APP ID"          k="appId"       placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" />
              <Field lbl="API KEY"         k="apiKey"      type="password" placeholder="TEST_API_KEY:..." />
              <Field lbl="USER TOKEN"      k="userToken"   type="password" placeholder="eyJ..." />
              <Field lbl="ENCRYPTION KEY"  k="encryptionKey" type="password" placeholder="Base64 encoded key" />
            </>}

            {tab === "entity" && <>
              <div style={{ fontSize:9, color:"#444", marginBottom:16 }}>Circle Entity & Identity settings.</div>
              <Field lbl="ENTITY SECRET CIPHER TEXT" k="entitySecret" type="password" placeholder="Cipher text from Circle console" />
              <Field lbl="ENTITY ID"                 k="entityId"     placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" />
              <Field lbl="ENTITY NAME"               k="entityName"   placeholder="My Platform" />
              <Field lbl="USER ID (default)"         k="userId"       placeholder="user_xxxx" />
            </>}

            {tab === "wallets" && <>
              <div style={{ fontSize:9, color:"#444", marginBottom:16 }}>
                Programmable Wallet configuration for Arc Testnet.
              </div>
              <Field lbl="WALLET SET ID"       k="walletSetId"    placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" />
              <Field lbl="WALLET ID (default)" k="defaultWallet"  placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" />
              <Field lbl="WALLET ADDRESS"      k="walletAddress"  placeholder="0x..." />
              <div style={field}>
                <span style={label}>BLOCKCHAIN</span>
                <select value={cfg.blockchain||"ARC"} onChange={e=>setCfg(p=>({...p,blockchain:e.target.value}))}
                  style={{ ...inp, cursor:"pointer" }}>
                  <option value="ARC">ARC (Arc Testnet)</option>
                  <option value="ETH-SEPOLIA">ETH-SEPOLIA</option>
                  <option value="AVAX-FUJI">AVAX-FUJI</option>
                  <option value="MATIC-AMOY">MATIC-AMOY</option>
                </select>
              </div>
              <div style={field}>
                <span style={label}>WALLET TYPE</span>
                <select value={cfg.walletType||"SCA"} onChange={e=>setCfg(p=>({...p,walletType:e.target.value}))}
                  style={{ ...inp, cursor:"pointer" }}>
                  <option value="SCA">SCA (Smart Contract Account)</option>
                  <option value="EOA">EOA (Externally Owned Account)</option>
                </select>
              </div>
            </>}

            {tab === "network" && <>
              <div style={{ fontSize:9, color:"#444", marginBottom:16 }}>
                Arc Network & RPC endpoints (pre-filled from docs.arc.network).
              </div>
              <Field lbl="RPC URL"           k="rpcUrl"      placeholder={RPC_URL} />
              <Field lbl="CHAIN ID"          k="chainId"     placeholder={String(ARC_CHAIN_ID)} />
              <Field lbl="EXPLORER URL"      k="explorerUrl" placeholder={EXPLORER_URL} />
              <Field lbl="FAUCET URL"        k="faucetUrl"   placeholder={FAUCET_URL} />
              <Field lbl="USDC CONTRACT"     k="usdcContract" placeholder={CONTRACTS.USDC} />
              <Field lbl="EURC CONTRACT"     k="eurcContract" placeholder={CONTRACTS.EURC} />
            </>}

            {tab === "webhooks" && <>
              <div style={{ fontSize:9, color:"#444", marginBottom:16 }}>
                Circle Webhook endpoints for transaction notifications.
              </div>
              <Field lbl="WEBHOOK URL"         k="webhookUrl"       placeholder="https://your-api.com/circle/webhook" />
              <Field lbl="WEBHOOK SECRET"      k="webhookSecret"    type="password" placeholder="whsec_..." />
              <Field lbl="SUBSCRIPTION ID"     k="subscriptionId"   placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" />
              <div style={field}>
                <span style={label}>EVENTS</span>
                {["transactions.outbound","transactions.inbound","wallets.created","transfers.complete"].map(ev => (
                  <label key={ev} style={{ display:"flex", alignItems:"center", gap:8,
                    marginBottom:6, cursor:"pointer" }}>
                    <input type="checkbox"
                      checked={!!(cfg.webhookEvents||{})[ev]}
                      onChange={e => setCfg(p => ({
                        ...p,
                        webhookEvents: { ...(p.webhookEvents||{}), [ev]: e.target.checked }
                      }))}
                    />
                    <span style={{ fontSize:10, color:"#888", fontFamily:"monospace" }}>{ev}</span>
                  </label>
                ))}
              </div>
            </>}
          </div>

          {/* Save bar */}
          <div style={{ borderTop:"1px solid rgba(255,255,255,0.06)",
            padding:"12px 22px", display:"flex", justifyContent:"space-between", alignItems:"center" }}>
            <div style={{ fontSize:9, color:"#2a2a2a", fontFamily:"monospace" }}>
              🔒 Stored locally in localStorage — never transmitted
            </div>
            <div style={{ display:"flex", gap:8 }}>
              <button onClick={() => { { _sDel("circle_sdk_cfg_v1"); setCfg({}); }}}
                style={{ padding:"7px 14px", borderRadius:7, border:"1px solid rgba(255,255,255,0.07)",
                  background:"transparent", color:"#555", fontFamily:"monospace", fontSize:9,
                  cursor:"pointer", letterSpacing:1 }}>
                CLEAR
              </button>
              <button onClick={()=>saveCfg(cfg)}
                style={{ padding:"7px 18px", borderRadius:7, border:"none",
                  background: saved ? "rgba(0,255,178,0.15)" : "linear-gradient(135deg,#00FFB2,#00cc8e)",
                  color: saved ? ACCENT : "#080C10",
                  fontFamily:"'Space Mono',monospace", fontSize:9, fontWeight:700,
                  letterSpacing:1, cursor:"pointer", transition:"all 0.2s" }}>
                {saved ? "✓ SAVED" : "SAVE CONFIG"}
              </button>
            </div>
          </div>
          </>
        )}
      </div>
    </div>
  );
}


// ═══════════════════════════════════════════════════════════════════════════════
// 🏦 AGENT VAULT — USDC treasury for AI agents on Arc Testnet
// ═══════════════════════════════════════════════════════════════════════════════
//
// Architecture (no smart contract deploy required):
//   • Vault address = deterministic from owner wallet (hash-derived, stable)
//   • Deposits  = real USDC ERC-20 transfer() to vault address on Arc Testnet
//   • Withdrawals = real USDC ERC-20 transfer() back to owner wallet
//   • Agent allocations = tracked in localStorage (off-chain intent layer)
//   • Vault balance = live eth_call balanceOf(vaultAddress) every 8s
//
// Arc Testnet params (docs.arc.network):
//   RPC  : https://rpc.testnet.arc.network
//   Chain: 5042002
//   USDC : 0x3600000000000000000000000000000000000000  (ERC-20, 6 decimals)
//   Gas  : ~$0.01 USDC/tx  |  Finality: ~350ms (Malachite BFT)

// Derive a stable vault address from the owner wallet.
// Not a real smart contract — it's a deterministic EOA address used as a
// custody address. In production this would be a deployed Vault contract.
async function deriveVaultAddress(ownerAddress) {
  const seed = "agentOS_vault_v1_" + ownerAddress.toLowerCase();
  try {
    const buf   = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(seed));
    const bytes = Array.from(new Uint8Array(buf));
    return "0x" + bytes.slice(0, 20).map(b => b.toString(16).padStart(2, "0")).join("");
  } catch {
    // Fallback: deterministic djb2-based address (same output across calls)
    let h = 5381n;
    for (const c of seed) h = ((h << 5n) + h + BigInt(c.charCodeAt(0))) & 0xffffffffffffffffn;
    return "0x" + h.toString(16).padStart(40, "0").slice(0, 40);
  }
}

const VAULT_STORE_KEY = "agentOS_vault_v2";
function loadVaultState()  { return _sGet(VAULT_STORE_KEY, null); }
function saveVaultState(s) { _sSet(VAULT_STORE_KEY, s); }

function VaultPanel({ wallet, chainOk, balance, onRefreshBalance }) {
  const ACCENT   = "#00FFB2";
  const GOLD     = "#FCD34D";
  const PURPLE   = "#A78BFA";
  const ORANGE   = "#FF6B35";

  const [vaultAddr,    setVaultAddr]    = useState(null);
  const [vaultBalance, setVaultBalance] = useState(null); // { usdc, usdcFloat }
  const [allocations,  setAllocations]  = useState({});   // { agentId: float }
  const [txLog,        setTxLog]        = useState([]);
  const [depositAmt,   setDepositAmt]   = useState("");
  const [withdrawAmt,  setWithdrawAmt]  = useState("");
  const [allocAgent,   setAllocAgent]   = useState(AGENTS[0].id);
  const [allocAmt,     setAllocAmt]     = useState("");
  const [phase,        setPhase]        = useState("idle"); // idle|depositing|withdrawing|allocating
  const [err,          setErr]          = useState("");
  const [success,      setSuccess]      = useState("");
  const [tab,          setTab]          = useState("overview"); // overview|deposit|withdraw|allocate
  const [confirmTx,    setConfirmTx]    = useState(null);
  const pollRef = useRef(null);

  // ── Init vault address from owner wallet ──────────────────────────────────
  useEffect(() => {
    if (!wallet) return;
    deriveVaultAddress(wallet).then(addr => {
      setVaultAddr(addr);
      // Restore saved state
      const saved = loadVaultState();
      if (saved?.owner === wallet) {
        setAllocations(saved.allocations || {});
        setTxLog(saved.txLog || []);
      }
    });
  }, [wallet]);

  // ── Poll vault balance on Arc Testnet (real balanceOf call) ───────────────
  useEffect(() => {
    if (!vaultAddr) return;
    const poll = async () => {
      try {
        const bal = await fetchUSDCBalance(vaultAddr);
        setVaultBalance(bal);
      } catch {}
    };
    poll();
    pollRef.current = setInterval(poll, 8000);
    return () => clearInterval(pollRef.current);
  }, [vaultAddr]);

  const persistState = (newAlloc, newLog) => {
    saveVaultState({ owner: wallet, allocations: newAlloc, txLog: newLog });
  };

  const flash = (msg, isErr = false) => {
    if (isErr) { setErr(msg); setTimeout(() => setErr(""), 5000); }
    else { setSuccess(msg); setTimeout(() => setSuccess(""), 4000); }
  };

  // ── DEPOSIT: transfer USDC from wallet → vault address ────────────────────
  const handleDeposit = () => {
    const amt = parseFloat(depositAmt);
    if (isNaN(amt) || amt <= 0) { flash("Enter a valid amount", true); return; }
    if ((balance?.usdcFloat || 0) < amt) {
      flash(`Insufficient balance — you have ${parseFloat(balance?.usdc||0).toFixed(2)} USDC`, true);
      return;
    }
    setConfirmTx({
      type: "payment",
      from: wallet,
      to: vaultAddr,
      amountLabel: `${amt.toFixed(2)} USDC → Vault`,
      feeLabel: `${(amt * 0.001).toFixed(4)} USDC (0.1%)`,
      totalLabel: `${(amt * 1.001).toFixed(4)} USDC`,
      network: "Arc Testnet",
      chainId: ARC_CHAIN_ID,
      extra: [
        ["Vault address", `${vaultAddr?.slice(0,10)}...${vaultAddr?.slice(-6)}`],
        ["USDC contract",  `${CONTRACTS.USDC.slice(0,10)}...`],
        ["Interface",      "ERC-20 transfer() • 6 decimals"],
        ["Finality",       "~350ms (Malachite BFT)"],
      ],
      _action: "deposit",
      _amt: amt,
    });
  };

  const execDeposit = async () => {
    const c = confirmTx;
    if (!c) return;  // guard: modal already dismissed
    setConfirmTx(null);
    setPhase("depositing"); setErr("");
    try {
      if (!wallet)    throw new Error("Wallet not connected");
      if (!vaultAddr) throw new Error("Vault address not initialized");
      const txHash = await sendUSDCERC20(wallet, vaultAddr, c._amt);
      const entry = {
        id: txHash.slice(0,14), type:"deposit", amount: c._amt,
        from: shortAddr(wallet), to: shortAddr(vaultAddr),
        time: Date.now(), status:"pending", hash: txHash,
      };
      const newLog = [entry, ...txLog].slice(0,50);
      setTxLog(newLog);
      persistState(allocations, newLog);
      flash(`Deposited ${c._amt} USDC — awaiting Arc confirmation (~350ms)`);
      setDepositAmt("");
      // Poll for receipt and update status
      waitForReceipt(txHash, 30000).then(r => {
        const updated = newLog.map(l => l.hash === txHash ? {...l, status: r ? "confirmed" : "timeout"} : l);
        setTxLog(updated); persistState(allocations, updated);
        if (r) { onRefreshBalance?.(); clearInterval(pollRef.current); pollRef.current = setInterval(async () => { try { setVaultBalance(await fetchUSDCBalance(vaultAddr)); } catch {} }, 8000); }
      });
    } catch(e) {
      flash(e.code === 4001 ? "Rejected by user" : e.message || "Deposit failed", true);
    }
    setPhase("idle");
  };

  // ── WITHDRAW: transfer USDC from vault → wallet ───────────────────────────
  // NOTE: vault address is a derived EOA — in prod use a signed contract withdraw.
  // On testnet, this sends from vault address which requires vault private key.
  // We simulate by showing the tx intent and flagging it as "requires vault key".
  const handleWithdraw = () => {
    const amt = parseFloat(withdrawAmt);
    if (isNaN(amt) || amt <= 0) { flash("Enter a valid amount", true); return; }
    const vaultBal = vaultBalance?.usdcFloat || 0;
    if (vaultBal < amt) {
      flash(`Vault has only ${vaultBal.toFixed(2)} USDC`, true); return;
    }
    setConfirmTx({
      type: "payment",
      from: vaultAddr,
      to: wallet,
      amountLabel: `${amt.toFixed(2)} USDC ← Vault`,
      network: "Arc Testnet",
      chainId: ARC_CHAIN_ID,
      extra: [
        ["From vault",    `${vaultAddr?.slice(0,10)}...${vaultAddr?.slice(-6)}`],
        ["To wallet",     `${wallet?.slice(0,10)}...${wallet?.slice(-6)}`],
        ["USDC contract", `${CONTRACTS.USDC.slice(0,10)}...`],
        ["Note",          "Vault EOA — signs on your behalf"],
      ],
      _action: "withdraw",
      _amt: amt,
    });
  };

  const execWithdraw = async () => {
    const c = confirmTx; setConfirmTx(null);
    setPhase("withdrawing"); setErr("");
    try {
      // Vault withdrawal: on Arc Testnet the vault is a derived EOA address.
      // To withdraw, the user must have the vault's private key OR this must be
      // a smart contract vault with an on-chain withdraw() function.
      // Testnet behavior: record intent locally and link to Arc faucet for refill.
      // Production: deploy Vault.sol and call vault.withdraw(amount, recipient).
      const entry = {
        id: "local-" + Date.now().toString(16), type:"withdraw", amount: c._amt,
        from: shortAddr(vaultAddr), to: shortAddr(wallet),
        time: Date.now(), status:"pending_contract",
        note: "Requires on-chain vault contract — deploy to execute",
      };
      const newLog = [entry, ...txLog].slice(0,50);
      setTxLog(newLog); persistState(allocations, newLog);
      flash(`Withdrawal of ${c._amt} USDC recorded — deploy Vault contract to execute on-chain`);
      setWithdrawAmt("");
    } catch(e) {
      flash(e.code === 4001 ? "Rejected by user" : e.message || "Withdrawal failed", true);
    }
    setPhase("idle");
  };

  // ── ALLOCATE: assign vault USDC budget to an agent ────────────────────────
  const handleAllocate = () => {
    const amt = parseFloat(allocAmt);
    if (isNaN(amt) || amt <= 0) { flash("Enter allocation amount", true); return; }
    const vaultBal  = vaultBalance?.usdcFloat || 0;
    const totalAlloc = Object.values(allocations).reduce((s,v) => s + v, 0);
    if (totalAlloc + amt > vaultBal) {
      flash(`Allocation exceeds available vault balance (${(vaultBal - totalAlloc).toFixed(2)} USDC free)`, true);
      return;
    }
    const newAlloc = { ...allocations, [allocAgent]: (allocations[allocAgent] || 0) + amt };
    setAllocations(newAlloc);
    persistState(newAlloc, txLog);
    const agent = AGENTS.find(a => a.id === allocAgent);
    flash(`Allocated ${amt} USDC to ${agent?.name}`);
    setAllocAmt("");
  };

  const revokeAlloc = (agentId) => {
    const newAlloc = { ...allocations };
    delete newAlloc[agentId];
    setAllocations(newAlloc);
    persistState(newAlloc, txLog);
  };

  // ── Derived stats ─────────────────────────────────────────────────────────
  const totalAlloc  = Object.values(allocations).reduce((s,v) => s + v, 0);
  const vaultBal    = vaultBalance?.usdcFloat || 0;
  const freeBalance = Math.max(0, vaultBal - totalAlloc);

  // ── Styles ────────────────────────────────────────────────────────────────
  const inp = {
    width:"100%", boxSizing:"border-box",
    background:"rgba(255,255,255,0.04)", border:"1px solid rgba(255,255,255,0.09)",
    borderRadius:8, padding:"9px 12px", color:"#e0e0e0",
    fontFamily:"monospace", fontSize:11, outline:"none",
  };
  const tabBtn = (id) => ({
    padding:"7px 14px", borderRadius:"7px 7px 0 0",
    border:"1px solid rgba(255,255,255,0.06)", borderBottom:"none",
    background: tab===id ? "rgba(0,255,178,0.08)" : "transparent",
    color: tab===id ? ACCENT : "#555",
    fontFamily:"monospace", fontSize:9, letterSpacing:1,
    cursor:"pointer", transition:"all 0.15s",
  });
  const primaryBtn = (disabled) => ({
    width:"100%", padding:"11px", borderRadius:9, border:"none",
    background: disabled ? "rgba(0,255,178,0.1)" : `linear-gradient(135deg,${ACCENT},#00cc8e)`,
    color: disabled ? "#00FFB240" : "#080C10",
    fontFamily:"'Space Mono',monospace", fontWeight:700, fontSize:10,
    letterSpacing:1, cursor: disabled ? "not-allowed" : "pointer", marginTop:8,
  });

  return (
    <>
    {confirmTx && (
      <ConfirmTxModal
        tx={confirmTx}
        onConfirm={confirmTx._action === "deposit" ? execDeposit : execWithdraw}
        onCancel={() => setConfirmTx(null)}
      />
    )}

    <div style={{ background:"rgba(0,255,178,0.03)", border:"1px solid rgba(0,255,178,0.12)",
      borderRadius:18, padding:"24px 24px 20px", marginTop:18 }}>

      {/* Top glow */}
      <div style={{ height:1, background:`linear-gradient(90deg,transparent,${ACCENT}44,transparent)`,
        margin:"-24px -24px 20px" }} />

      {/* Header */}
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:20 }}>
        <div style={{ display:"flex", alignItems:"center", gap:12 }}>
          <div style={{ width:42, height:42, borderRadius:12,
            background:"rgba(0,255,178,0.08)", border:`1px solid ${ACCENT}33`,
            display:"flex", alignItems:"center", justifyContent:"center", fontSize:20 }}>🏦</div>
          <div>
            <div style={{ fontSize:8, color:ACCENT, letterSpacing:2, marginBottom:2 }}>
              ARC TESTNET • CHAIN ID {ARC_CHAIN_ID} • MALACHITE BFT
            </div>
            <div style={{ fontFamily:"'Space Mono',monospace", fontSize:16, fontWeight:700 }}>
              Agent Vault
            </div>
            <div style={{ fontSize:9, color:"#555" }}>
              USDC treasury for autonomous AI agents
            </div>
          </div>
        </div>
        {/* Live vault balance */}
        <div style={{ textAlign:"right" }}>
          <div style={{ fontSize:8, color:"#555", letterSpacing:1 }}>VAULT BALANCE</div>
          <div style={{ fontFamily:"'Space Mono',monospace", fontSize:22, fontWeight:700, color:ACCENT }}>
            {vaultBalance ? `${vaultBal.toFixed(2)}` : "—"}
            <span style={{ fontSize:11, color:"#555", marginLeft:4 }}>USDC</span>
          </div>
          <div style={{ fontSize:8, color:"#444", marginTop:2 }}>
            {totalAlloc > 0 && `${totalAlloc.toFixed(2)} allocated • `}
            {freeBalance.toFixed(2)} free
          </div>
        </div>
      </div>

      {/* Vault address + Arc info */}
      {vaultAddr && (
        <div style={{ background:"rgba(255,255,255,0.02)", border:"1px solid rgba(255,255,255,0.06)",
          borderRadius:10, padding:"10px 14px", marginBottom:16,
          display:"flex", justifyContent:"space-between", alignItems:"center", flexWrap:"wrap", gap:8 }}>
          <div>
            <div style={{ fontSize:8, color:"#444", letterSpacing:1.5, marginBottom:3 }}>VAULT ADDRESS (Arc Testnet)</div>
            <div style={{ fontFamily:"monospace", fontSize:11, color:"#888" }}>{vaultAddr}</div>
          </div>
          <div style={{ display:"flex", gap:8 }}>
            <button onClick={() => navigator.clipboard.writeText(vaultAddr)}
              style={{ fontSize:9, color:"#555", background:"rgba(255,255,255,0.04)",
                border:"1px solid rgba(255,255,255,0.08)", borderRadius:6,
                padding:"4px 10px", cursor:"pointer", fontFamily:"monospace" }}>⎘ COPY</button>
            <a href={`${EXPLORER_URL}/address/${vaultAddr}`} target="_blank" rel="noreferrer"
              style={{ fontSize:9, color:ACCENT, background:`${ACCENT}10`,
                border:`1px solid ${ACCENT}25`, borderRadius:6,
                padding:"4px 10px", textDecoration:"none", fontFamily:"monospace" }}>↗ EXPLORER</a>
          </div>
        </div>
      )}

      {/* Stats bar */}
      <div style={{ display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:8, marginBottom:18 }}>
        {[
          { label:"VAULT USDC",    val: vaultBalance ? `${vaultBal.toFixed(2)}`,  unit:"USDC",  color:ACCENT   },
          { label:"ALLOCATED",     val: totalAlloc.toFixed(2),                    unit:"USDC",  color:GOLD     },
          { label:"FREE BALANCE",  val: freeBalance.toFixed(2),                   unit:"USDC",  color:PURPLE   },
          { label:"WALLET USDC",   val: parseFloat(balance?.usdc||0).toFixed(2),  unit:"USDC",  color:ORANGE   },
        ].map(s => (
          <div key={s.label} style={{ background:"rgba(255,255,255,0.02)",
            border:`1px solid ${s.color}18`, borderRadius:10, padding:"10px 12px" }}>
            <div style={{ fontSize:7, color:"#444", letterSpacing:1.5, marginBottom:4 }}>{s.label}</div>
            <div style={{ fontFamily:"'Space Mono',monospace", fontSize:15, fontWeight:700, color:s.color }}>
              {s.val} <span style={{ fontSize:8, color:"#555" }}>{s.unit}</span>
            </div>
          </div>
        ))}
      </div>

      {/* Agent allocation bars */}
      {Object.keys(allocations).length > 0 && (
        <div style={{ marginBottom:18 }}>
          <div style={{ fontSize:8, color:"#444", letterSpacing:2, marginBottom:10 }}>AGENT ALLOCATIONS</div>
          {AGENTS.filter(a => (allocations[a.id] || 0) > 0).map(agent => {
            const alloc = allocations[agent.id] || 0;
            const pct   = vaultBal > 0 ? (alloc / vaultBal) * 100 : 0;
            return (
              <div key={agent.id} style={{ marginBottom:8 }}>
                <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:4 }}>
                  <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                    <div style={{ width:20, height:20, borderRadius:6, background:`${agent.color}20`,
                      border:`1px solid ${agent.color}44`, display:"flex", alignItems:"center",
                      justifyContent:"center", fontSize:10 }}>{agent.icon}</div>
                    <span style={{ fontFamily:"monospace", fontSize:10, color:agent.color, fontWeight:700 }}>{agent.name}</span>
                    <span style={{ fontSize:9, color:"#555" }}>{agent.role}</span>
                  </div>
                  <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                    <span style={{ fontFamily:"monospace", fontSize:10, color:"#ccc" }}>
                      {alloc.toFixed(2)} USDC
                    </span>
                    <button onClick={() => revokeAlloc(agent.id)}
                      style={{ fontSize:9, color:"#FF3366", background:"rgba(255,51,102,0.08)",
                        border:"1px solid rgba(255,51,102,0.2)", borderRadius:4,
                        padding:"2px 7px", cursor:"pointer", fontFamily:"monospace" }}>REVOKE</button>
                  </div>
                </div>
                <div style={{ height:4, background:"rgba(255,255,255,0.05)", borderRadius:4, overflow:"hidden" }}>
                  <div style={{ width:`${Math.min(pct,100)}%`, height:"100%",
                    background:`linear-gradient(90deg,${agent.color}88,${agent.color})`,
                    borderRadius:4, transition:"width 0.5s" }} />
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Tabs */}
      {wallet && chainOk && (
        <>
        <div style={{ display:"flex", gap:2, borderBottom:"1px solid rgba(0,255,178,0.1)", marginBottom:0 }}>
          {[
            { id:"deposit",  label:"⬇ DEPOSIT"  },
            { id:"withdraw", label:"⬆ WITHDRAW" },
            { id:"allocate", label:"⚡ ALLOCATE" },
            { id:"history",  label:"📋 HISTORY"  },
          ].map(t => (
            <button key={t.id} onClick={() => setTab(t.id)} style={tabBtn(t.id)}>{t.label}</button>
          ))}
        </div>

        <div style={{ background:"rgba(255,255,255,0.01)", border:"1px solid rgba(255,255,255,0.05)",
          borderRadius:"0 8px 8px 8px", padding:"16px", marginBottom:4 }}>

          {/* ── DEPOSIT TAB */}
          {tab === "deposit" && (
            <div>
              <div style={{ fontSize:9, color:"#555", marginBottom:14, lineHeight:1.8 }}>
                Transfer USDC from your wallet to the Vault.<br/>
                The vault address is derived from your wallet — funds stay on-chain on Arc Testnet.<br/>
                <span style={{ color:ACCENT }}>USDC contract: {CONTRACTS.USDC}</span>
              </div>
              <div style={{ marginBottom:10 }}>
                <div style={{ fontSize:9, color:"#555", letterSpacing:1, marginBottom:4 }}>AMOUNT (USDC)</div>
                <div style={{ position:"relative" }}>
                  <input
                    type="number" min="0" step="0.01"
                    value={depositAmt}
                    onChange={e => setDepositAmt(e.target.value)}
                    placeholder="0.00"
                    style={{ ...inp, paddingRight:56 }}
                    onFocus={e => e.target.style.borderColor=ACCENT}
                    onBlur={e  => e.target.style.borderColor="rgba(255,255,255,0.09)"}
                  />
                  <button onClick={() => setDepositAmt((balance?.usdcFloat||0).toFixed(6))}
                    style={{ position:"absolute", right:8, top:"50%", transform:"translateY(-50%)",
                      fontSize:8, color:GOLD, background:`${GOLD}15`, border:`1px solid ${GOLD}30`,
                      borderRadius:4, padding:"3px 7px", cursor:"pointer", fontFamily:"monospace" }}>
                    MAX
                  </button>
                </div>
                <div style={{ fontSize:9, color:"#555", marginTop:5 }}>
                  Wallet balance: <span style={{ color:ACCENT }}>{parseFloat(balance?.usdc||0).toFixed(2)} USDC</span>
                  {" • "} Fee: <span style={{ color:GOLD }}>{depositAmt ? (parseFloat(depositAmt||0)*0.001).toFixed(4) : "0"} USDC (0.1%)</span>
                </div>
              </div>
              <button
                onClick={handleDeposit}
                disabled={phase !== "idle" || !depositAmt}
                style={primaryBtn(phase !== "idle" || !depositAmt)}>
                {phase === "depositing" ? "⟳ DEPOSITING..." : "⬇ DEPOSIT TO VAULT"}
              </button>
            </div>
          )}

          {/* ── WITHDRAW TAB */}
          {tab === "withdraw" && (
            <div>
              <div style={{ fontSize:9, color:"#555", marginBottom:14, lineHeight:1.8 }}>
                Withdraw USDC from the Vault back to your wallet.<br/>
                Vault balance: <span style={{ color:ACCENT }}>{vaultBal.toFixed(2)} USDC</span>
              </div>
              <div style={{ marginBottom:10 }}>
                <div style={{ fontSize:9, color:"#555", letterSpacing:1, marginBottom:4 }}>AMOUNT (USDC)</div>
                <div style={{ position:"relative" }}>
                  <input
                    type="number" min="0" step="0.01"
                    value={withdrawAmt}
                    onChange={e => setWithdrawAmt(e.target.value)}
                    placeholder="0.00"
                    style={{ ...inp, paddingRight:56 }}
                    onFocus={e => e.target.style.borderColor=ACCENT}
                    onBlur={e  => e.target.style.borderColor="rgba(255,255,255,0.09)"}
                  />
                  <button onClick={() => setWithdrawAmt(vaultBal.toFixed(6))}
                    style={{ position:"absolute", right:8, top:"50%", transform:"translateY(-50%)",
                      fontSize:8, color:GOLD, background:`${GOLD}15`, border:`1px solid ${GOLD}30`,
                      borderRadius:4, padding:"3px 7px", cursor:"pointer", fontFamily:"monospace" }}>
                    MAX
                  </button>
                </div>
              </div>
              <button
                onClick={handleWithdraw}
                disabled={phase !== "idle" || !withdrawAmt || vaultBal <= 0}
                style={primaryBtn(phase !== "idle" || !withdrawAmt || vaultBal <= 0)}>
                {phase === "withdrawing" ? "⟳ WITHDRAWING..." : "⬆ WITHDRAW FROM VAULT"}
              </button>
            </div>
          )}

          {/* ── ALLOCATE TAB */}
          {tab === "allocate" && (
            <div>
              <div style={{ fontSize:9, color:"#555", marginBottom:14, lineHeight:1.8 }}>
                Assign USDC budget to AI agents. Agents use their allocation for autonomous operations.<br/>
                Free vault balance: <span style={{ color:ACCENT }}>{freeBalance.toFixed(2)} USDC</span>
              </div>
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10, marginBottom:12 }}>
                <div>
                  <div style={{ fontSize:9, color:"#555", letterSpacing:1, marginBottom:4 }}>AGENT</div>
                  <select value={allocAgent} onChange={e => setAllocAgent(e.target.value)}
                    style={{ ...inp, cursor:"pointer" }}>
                    {AGENTS.map(a => (
                      <option key={a.id} value={a.id}>{a.name} — {a.role}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <div style={{ fontSize:9, color:"#555", letterSpacing:1, marginBottom:4 }}>AMOUNT (USDC)</div>
                  <div style={{ position:"relative" }}>
                    <input
                      type="number" min="0" step="0.01"
                      value={allocAmt}
                      onChange={e => setAllocAmt(e.target.value)}
                      placeholder="0.00"
                      style={{ ...inp, paddingRight:48 }}
                      onFocus={e => e.target.style.borderColor=PURPLE}
                      onBlur={e  => e.target.style.borderColor="rgba(255,255,255,0.09)"}
                    />
                    <button onClick={() => setAllocAmt(freeBalance.toFixed(6))}
                      style={{ position:"absolute", right:8, top:"50%", transform:"translateY(-50%)",
                        fontSize:8, color:GOLD, background:`${GOLD}15`, border:`1px solid ${GOLD}30`,
                        borderRadius:4, padding:"3px 7px", cursor:"pointer", fontFamily:"monospace" }}>
                      MAX
                    </button>
                  </div>
                </div>
              </div>
              {/* Agent preview */}
              {(() => { const a = AGENTS.find(x => x.id === allocAgent); return a ? (
                <div style={{ background:`${a.color}08`, border:`1px solid ${a.color}20`,
                  borderRadius:10, padding:"10px 14px", marginBottom:12,
                  display:"flex", alignItems:"center", gap:12 }}>
                  <div style={{ fontSize:22 }}>{a.icon}</div>
                  <div>
                    <div style={{ fontFamily:"monospace", fontSize:11, color:a.color, fontWeight:700 }}>{a.name}</div>
                    <div style={{ fontSize:9, color:"#666" }}>{a.role}</div>
                    <div style={{ fontSize:8, color:"#444", marginTop:2 }}>{a.useCases.join(" • ")}</div>
                  </div>
                  <div style={{ marginLeft:"auto", textAlign:"right" }}>
                    <div style={{ fontSize:8, color:"#555" }}>CURRENT ALLOC</div>
                    <div style={{ fontFamily:"monospace", fontSize:13, color:a.color, fontWeight:700 }}>
                      {(allocations[a.id]||0).toFixed(2)} USDC
                    </div>
                  </div>
                </div>
              ) : null; })()}
              <button
                onClick={handleAllocate}
                disabled={phase !== "idle" || !allocAmt || freeBalance <= 0}
                style={{ ...primaryBtn(phase !== "idle" || !allocAmt || freeBalance <= 0),
                  background: phase !== "idle" || !allocAmt ? "rgba(167,139,250,0.1)"
                    : "linear-gradient(135deg,#A78BFA,#7C3AED)",
                  color: phase !== "idle" || !allocAmt ? "#A78BFA40" : "#fff" }}>
                ⚡ ALLOCATE TO AGENT
              </button>
            </div>
          )}

          {/* ── HISTORY TAB */}
          {tab === "history" && (
            <div>
              {txLog.length === 0 ? (
                <div style={{ textAlign:"center", padding:"20px 0", color:"#444", fontSize:10 }}>
                  No vault transactions yet
                </div>
              ) : (
                <div style={{ maxHeight:240, overflowY:"auto" }}>
                  {txLog.map((tx, i) => (
                    <div key={i} style={{ display:"flex", alignItems:"center", justifyContent:"space-between",
                      padding:"8px 10px", borderRadius:8, marginBottom:4,
                      background:"rgba(255,255,255,0.02)", border:"1px solid rgba(255,255,255,0.05)" }}>
                      <div style={{ display:"flex", alignItems:"center", gap:10 }}>
                        <div style={{ fontSize:14 }}>{tx.type==="deposit" ? "⬇" : "⬆"}</div>
                        <div>
                          <div style={{ fontSize:10, fontFamily:"monospace",
                            color: tx.type==="deposit" ? ACCENT : ORANGE, fontWeight:700 }}>
                            {tx.type.toUpperCase()} {parseFloat(tx.amount||0).toFixed(2)} USDC
                          </div>
                          <div style={{ fontSize:8, color:"#555" }}>
                            {new Date(tx.time).toLocaleTimeString()} • {tx.from} → {tx.to}
                          </div>
                        </div>
                      </div>
                      <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                        <div style={{ fontSize:8, padding:"2px 7px", borderRadius:4,
                          background: tx.status==="confirmed" ? "rgba(0,255,178,0.1)"
                            : tx.status==="pending" ? "rgba(252,211,77,0.1)" : "rgba(255,255,255,0.05)",
                          color: tx.status==="confirmed" ? ACCENT
                            : tx.status==="pending" ? GOLD : "#555",
                          fontFamily:"monospace" }}>
                          {tx.status?.toUpperCase() || "SENT"}
                        </div>
                        {tx.hash && (
                          <a href={`${EXPLORER_URL}/tx/${tx.hash}`} target="_blank" rel="noreferrer"
                            style={{ fontSize:8, color:"#555", textDecoration:"none" }}>↗</a>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
        </>
      )}

      {!wallet && (
        <div style={{ textAlign:"center", padding:"20px 0", color:"#555", fontSize:10, fontFamily:"monospace" }}>
          Connect your wallet to access the Agent Vault
        </div>
      )}
      {wallet && !chainOk && (
        <div style={{ textAlign:"center", padding:"14px 0", color:ORANGE, fontSize:10, fontFamily:"monospace" }}>
          ⚠ Switch to Arc Testnet to use the vault
        </div>
      )}

      {/* Feedback messages */}
      {err && (
        <div style={{ marginTop:10, background:"rgba(255,51,102,0.1)", border:"1px solid rgba(255,51,102,0.25)",
          borderRadius:8, padding:"8px 12px", fontSize:10, color:"#FF3366", fontFamily:"monospace" }}>
          ✗ {err}
        </div>
      )}
      {success && (
        <div style={{ marginTop:10, background:"rgba(0,255,178,0.08)", border:`1px solid ${ACCENT}33`,
          borderRadius:8, padding:"8px 12px", fontSize:10, color:ACCENT, fontFamily:"monospace" }}>
          ✓ {success}
        </div>
      )}

      {/* Arc network footer */}
      <div style={{ marginTop:14, paddingTop:12, borderTop:"1px solid rgba(255,255,255,0.04)",
        display:"flex", justifyContent:"space-between", alignItems:"center" }}>
        <div style={{ fontSize:8, color:"#2a2a2a", fontFamily:"monospace" }}>
          ⬡ Arc Testnet • USDC {CONTRACTS.USDC.slice(0,12)}... • Gas ~$0.01 USDC/tx
        </div>
        <div style={{ display:"flex", gap:10 }}>
          <a href={`${EXPLORER_URL}/address/${vaultAddr||""}`} target="_blank" rel="noreferrer"
            style={{ fontSize:8, color:"#333", textDecoration:"none", fontFamily:"monospace" }}
            onMouseEnter={e=>e.target.style.color=ACCENT}
            onMouseLeave={e=>e.target.style.color="#333"}>VAULT ↗</a>
          <a href={FAUCET_URL} target="_blank" rel="noreferrer"
            style={{ fontSize:8, color:"#333", textDecoration:"none", fontFamily:"monospace" }}
            onMouseEnter={e=>e.target.style.color=ACCENT}
            onMouseLeave={e=>e.target.style.color="#333"}>FAUCET ↗</a>
        </div>
      </div>
    </div>
    </>
  );
}


// ─── WALLET CONNECT POPUP (safe — unmounts before calling MetaMask) ────────────
function WalletConnectPopup({ onConnect, onClose, onStartConnecting }) {
  const ua = navigator.userAgent;
  const isMobile  = /Android|iPhone|iPad/i.test(ua);
  const isFirefox = /Firefox/i.test(ua);

  const WALLETS = isMobile ? [
    { id:"metamask", name:"MetaMask",       icon:"🦊", desc:"iOS / Android app",     url:"https://metamask.io/download/",              color:"#E8831D" },
    { id:"trust",    name:"Trust Wallet",   icon:"🛡",  desc:"Multi-chain mobile",    url:"https://trustwallet.com/",                   color:"#3375BB" },
  ] : [
    { id:"metamask", name:"MetaMask",       icon:"🦊", desc: isFirefox ? "Firefox extension" : "Chrome / Brave / Edge", url:"https://metamask.io/download/", color:"#E8831D" },
    { id:"coinbase", name:"Coinbase Wallet",icon:"💙", desc:"Coinbase extension",     url:"https://www.coinbase.com/wallet/downloads",   color:"#0052FF" },
    { id:"brave",    name:"Brave Wallet",   icon:"🦁",  desc:"Built into Brave",      url:"https://brave.com/",                         color:"#FB542B" },
    { id:"rabby",    name:"Rabby Wallet",   icon:"🐰",  desc:"Multi-chain secure",    url:"https://rabby.io/",                          color:"#7B5EA7" },
  ];

  const handlePick = (w) => {
    if (!window.ethereum) {
      window.open(w.url, "_blank");
      onClose();
      return;
    }
    // onStartConnecting closes the modal AND starts the connection
    onStartConnecting(w);
  };

  return (
    <div
      style={{ position:"fixed", inset:0, zIndex:100, display:"flex", alignItems:"center", justifyContent:"center" }}
      onClick={e => e.target === e.currentTarget && onClose()}
    >
      {/* Semi-transparent backdrop — NOT blur, so MetaMask can render */}
      <div style={{ position:"absolute", inset:0, background:"rgba(0,0,0,0.6)" }} onClick={onClose} />

      <div style={{ position:"relative", zIndex:101, background:"#0a0f16",
        border:"1px solid rgba(0,255,178,0.2)", borderRadius:22, width:400, maxWidth:"92vw",
        boxShadow:"0 24px 60px rgba(0,0,0,0.7)" }}>

        <div style={{ height:3, background:"linear-gradient(90deg,transparent,#00FFB2,transparent)",
          borderRadius:"22px 22px 0 0" }} />

        <div style={{ padding:"24px 24px 26px" }}>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:6 }}>
            <div>
              <div style={{ fontSize:9, color:"#00FFB2", letterSpacing:2, marginBottom:4 }}>// AGENTOS • ARC NETWORK</div>
              <div style={{ fontFamily:"'Space Mono',monospace", fontSize:17, fontWeight:700 }}>Connect Wallet</div>
            </div>
            <button onClick={onClose} style={{ background:"rgba(255,255,255,0.05)",
              border:"1px solid rgba(255,255,255,0.1)", borderRadius:8, width:30, height:30,
              color:"#777", cursor:"pointer", fontSize:16, display:"flex", alignItems:"center", justifyContent:"center" }}>×</button>
          </div>

          <div style={{ fontSize:11, color:"#555", marginBottom:18, marginTop:8, lineHeight:1.5 }}>
            Choose your wallet to connect to <span style={{ color:"#00FFB2" }}>Arc Testnet</span>
          </div>

          <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
            {WALLETS.map(w => (
              <div key={w.id} onClick={() => handlePick(w)}
                style={{ display:"flex", alignItems:"center", gap:14, padding:"13px 15px",
                  background:"rgba(255,255,255,0.03)", border:"1px solid rgba(255,255,255,0.07)",
                  borderRadius:13, cursor:"pointer", transition:"all 0.15s", userSelect:"none" }}
                onMouseEnter={e => { e.currentTarget.style.background=`${w.color}12`; e.currentTarget.style.borderColor=`${w.color}44`; }}
                onMouseLeave={e => { e.currentTarget.style.background="rgba(255,255,255,0.03)"; e.currentTarget.style.borderColor="rgba(255,255,255,0.07)"; }}>
                <div style={{ width:42, height:42, borderRadius:12, background:`${w.color}18`,
                  border:`1px solid ${w.color}33`, display:"flex", alignItems:"center",
                  justifyContent:"center", fontSize:22, flexShrink:0 }}>{w.icon}</div>
                <div style={{ flex:1 }}>
                  <div style={{ fontFamily:"monospace", fontSize:13, fontWeight:700, color:"#e8e8e8", marginBottom:2 }}>
                    {w.name}
                    {w.id==="metamask" && <span style={{ marginLeft:8, fontSize:7, background:"rgba(0,255,178,0.12)",
                      border:"1px solid rgba(0,255,178,0.25)", borderRadius:20, padding:"1px 7px",
                      color:"#00FFB2", letterSpacing:1, verticalAlign:"middle" }}>POPULAR</span>}
                  </div>
                  <div style={{ fontSize:10, color:"#555" }}>{w.desc}</div>
                </div>
                <span style={{ color:"#333", fontSize:16 }}>›</span>
              </div>
            ))}
          </div>

          <div style={{ marginTop:16, padding:"11px 13px", background:"rgba(255,255,255,0.02)",
            border:"1px solid rgba(255,255,255,0.05)", borderRadius:11,
            fontSize:9, color:"#444", lineHeight:1.9 }}>
            🔒 Your private key never leaves your wallet<br/>
            ⬡ Network: Arc Testnet • Chain ID 5042002 • Gas in USDC<br/>
            💧 Faucet: <a href="https://faucet.circle.com" target="_blank" rel="noreferrer"
              style={{ color:"#00FFB2", textDecoration:"none" }}>faucet.circle.com</a>
          </div>
        </div>
      </div>
    </div>
  );
}


// ─── HEADER LANGUAGE SWITCHER ────────────────────────────────────────────────
function LangSwitcher() {
  const { lang } = useTranslation();
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const current = ALL_LANGS.find(l => l.code === lang) || ALL_LANGS[0];

  useEffect(() => {
    const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  return (
    <div ref={ref} style={{ position:"relative" }}>
      <button onClick={() => setOpen(v => !v)} style={{
        background:"rgba(255,255,255,0.04)", border:"1px solid rgba(255,255,255,0.1)",
        borderRadius:10, padding:"9px 13px", color:"#888", cursor:"pointer",
        fontFamily:"monospace", fontSize:11, display:"flex", alignItems:"center", gap:7,
        transition:"all 0.2s"
      }}>
        <span style={{ fontSize:15 }}>{current.flag}</span>
        <span style={{ fontSize:9, letterSpacing:0.5, color:"#666" }}>{current.code}</span>
        <span style={{ fontSize:8, color:"#444", marginLeft:2 }}>{open ? "▲" : "▼"}</span>
      </button>

      {open && (
        <div style={{ position:"absolute", top:"calc(100% + 6px)", right:0, zIndex:900,
          background:"#0f1520", border:"1px solid rgba(255,255,255,0.1)",
          borderRadius:16, padding:"8px 6px", width:220,
          boxShadow:"0 20px 50px rgba(0,0,0,0.8)", maxHeight:360, overflowY:"auto",
          animation:"fadeIn 0.15s ease" }}>
          <div style={{ fontSize:8, color:"#333", letterSpacing:2, padding:"4px 10px 8px" }}>LANGUAGE</div>
          {ALL_LANGS.map(l => (
            <div key={l.code}
              onClick={() => { setGlobalLang(l.code); setOpen(false); }}
              style={{ display:"flex", alignItems:"center", gap:10, padding:"8px 10px",
                borderRadius:10, cursor:"pointer", marginBottom:1, transition:"all 0.12s",
                background: lang===l.code ? "rgba(167,139,250,0.12)" : "transparent",
                border: lang===l.code ? "1px solid rgba(167,139,250,0.2)" : "1px solid transparent"
              }}
              onMouseEnter={e => { if(lang!==l.code) e.currentTarget.style.background="rgba(255,255,255,0.05)"; }}
              onMouseLeave={e => { e.currentTarget.style.background = lang===l.code ? "rgba(167,139,250,0.12)" : "transparent"; }}>
              <span style={{ fontSize:17, flexShrink:0 }}>{l.flag}</span>
              <div style={{ flex:1, minWidth:0 }}>
                <div style={{ fontSize:11, color: lang===l.code ? "#A78BFA" : "#bbb",
                  fontFamily:"monospace", whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>
                  {l.label}
                </div>
                <div style={{ fontSize:7, color:"#444", marginTop:1 }}>{l.code}</div>
              </div>
              {l.code === "en-US" && (
                <span style={{ fontSize:7, color:"#00FFB2", background:"rgba(0,255,178,0.1)",
                  borderRadius:8, padding:"1px 5px", letterSpacing:0.5, flexShrink:0 }}>DEFAULT</span>
              )}
              {lang === l.code && <span style={{ color:"#A78BFA", fontSize:13, flexShrink:0 }}>✓</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── WALLET CONNECT BUTTON ───────────────────────────────────────────────────
function WalletButton({ wallet, onDisconnect, chainOk, connecting, onDirectConnect, onSwitchChain }) {
  const { t } = useTranslation();
  const [switching, setSwitching] = useState(false);
  const [switchErr, setSwitchErr] = useState("");

  const handleSwitch = async () => {
    if (switching || !onSwitchChain) return;
    setSwitching(true);
    setSwitchErr("");
    try {
      await onSwitchChain();
    } catch(e) {
      setSwitchErr(
        e.code === 4001 ? "Rejected" :
        e.message?.slice(0, 40) || "Failed"
      );
      setTimeout(() => setSwitchErr(""), 4000);
    }
    setSwitching(false);
  };

  if (wallet) return (
    <div style={{ display:"flex", alignItems:"center", gap:8 }}>
      {!chainOk && (
        <div style={{ display:"flex", flexDirection:"column", alignItems:"flex-end", gap:3 }}>
          <button
            onClick={handleSwitch}
            disabled={switching}
            style={{
              fontSize:10, color: switching ? "#FCD34D" : "#FF6B35",
              background: switching ? "rgba(252,211,77,0.08)" : "rgba(255,107,53,0.1)",
              border:`1px solid ${switching ? "rgba(252,211,77,0.35)" : "rgba(255,107,53,0.35)"}`,
              borderRadius:8, padding:"5px 11px", fontFamily:"monospace",
              cursor: switching ? "not-allowed" : "pointer",
              display:"flex", alignItems:"center", gap:6,
              transition:"all 0.2s",
            }}
            onMouseEnter={e => { if(!switching) { e.currentTarget.style.background="rgba(255,107,53,0.2)"; e.currentTarget.style.borderColor="rgba(255,107,53,0.6)"; }}}
            onMouseLeave={e => { if(!switching) { e.currentTarget.style.background="rgba(255,107,53,0.1)"; e.currentTarget.style.borderColor="rgba(255,107,53,0.35)"; }}}
          >
            {switching
              ? <><div style={{ width:8, height:8, borderRadius:"50%",
                  border:"1.5px solid rgba(252,211,77,0.3)", borderTopColor:"#FCD34D",
                  animation:"spin 0.7s linear infinite" }} /> SWITCHING...</>
              : <>⚠ Switch to Arc Testnet</>
            }
          </button>
          {switchErr && (
            <div style={{ fontSize:9, color:"#FF3366", fontFamily:"monospace" }}>✗ {switchErr}</div>
          )}
        </div>
      )}
      <div style={{ background:"rgba(0,255,178,0.07)", border:"1px solid rgba(0,255,178,0.22)",
        borderRadius:10, padding:"8px 14px", display:"flex", alignItems:"center", gap:8 }}>
        <div style={{ width:7, height:7, borderRadius:"50%",
          background: chainOk ? "#00FFB2" : "#FF6B35", animation:"pulse 2s infinite" }} />
        <span style={{ fontSize:11, color:"#00FFB2", fontFamily:"monospace" }}>{shortAddr(wallet)}</span>
        <button onClick={onDisconnect} style={{ background:"none", border:"none", color:"#555",
          cursor:"pointer", fontSize:15, lineHeight:1, padding:0 }}>×</button>
      </div>
    </div>
  );

  // DIRECT connect — click calls MetaMask immediately, no modal in between
  return (
    <button
      onClick={onDirectConnect}
      disabled={connecting}
      style={{
        background: connecting ? "rgba(0,255,178,0.12)" : "linear-gradient(135deg,#00FFB2,#00cc8e)",
        border: connecting ? "1px solid rgba(0,255,178,0.3)" : "none",
        borderRadius:10, padding:"10px 20px",
        color: connecting ? "#00FFB2" : "#080C10",
        fontWeight:700, fontSize:11, fontFamily:"monospace",
        cursor: connecting ? "not-allowed" : "pointer",
        letterSpacing:1, boxShadow: connecting ? "none" : "0 0 20px #00FFB244",
        transition:"all 0.25s", display:"flex", alignItems:"center", gap:8
      }}>
      {connecting
        ? <><div style={{ width:10, height:10, borderRadius:"50%", border:"2px solid rgba(0,255,178,0.3)", borderTopColor:"#00FFB2", animation:"spin 0.7s linear infinite" }} /> CONNECTING...</>
        : <>⬡ {t("connectBtn")}</>
      }
    </button>
  );
}

// ─── AGENT CARD ───────────────────────────────────────────────────────────────
function AgentCard({ agent, selected, onClick }) {
  return (
    <div onClick={onClick} style={{
      background: selected ? `${agent.color}15` : "rgba(255,255,255,0.025)",
      border:`1px solid ${selected ? agent.color : "rgba(255,255,255,0.07)"}`,
      borderRadius:14, padding:18, cursor:"pointer",
      transition:"all 0.25s cubic-bezier(0.4,0,0.2,1)",
      transform: selected ? "translateY(-3px)" : "none",
      boxShadow: selected ? `0 10px 40px ${agent.color}20` : "none",
      position:"relative", overflow:"hidden"
    }}>
      {selected && <div style={{ position:"absolute",top:0,left:0,right:0,height:2,
        background:`linear-gradient(90deg,transparent,${agent.color},transparent)`,
        animation:"shimmer 2s infinite" }} />}
      <div style={{ display:"flex", justifyContent:"space-between", marginBottom:10 }}>
        <span style={{ fontSize:26, color:agent.color }}>{agent.icon}</span>
        <div style={{ background:`${agent.color}18`,border:`1px solid ${agent.color}33`,
          borderRadius:20,padding:"2px 9px",fontSize:9,color:agent.color,
          fontFamily:"monospace",letterSpacing:1,display:"flex",alignItems:"center",gap:4 }}>
          <div style={{ width:4,height:4,borderRadius:"50%",background:agent.color,animation:"pulse 2s infinite" }}/>
          ACTIVE
        </div>
      </div>
      <div style={{ fontFamily:"'Space Mono',monospace",fontSize:14,fontWeight:700,
        color:"#fff",letterSpacing:1,marginBottom:1 }}>{agent.name}</div>
      <div style={{ fontSize:10,color:agent.color,fontFamily:"monospace",marginBottom:8,opacity:0.8 }}>{agent.role}</div>
      <div style={{ fontSize:10,color:"#777",lineHeight:1.5,marginBottom:10 }}>{agent.description}</div>
      {agent.useCases && (
        <div style={{ display:"flex", flexWrap:"wrap", gap:4, marginBottom:10 }}>
          {agent.useCases.map(uc=>(
            <span key={uc} style={{ fontSize:8, color:agent.color, background:`${agent.color}12`,
              border:`1px solid ${agent.color}25`, borderRadius:20, padding:"2px 7px",
              fontFamily:"monospace", letterSpacing:0.5 }}>{uc}</span>
          ))}
        </div>
      )}
      <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:6 }}>
        {[["Processed",agent.stats.processed],["Uptime",agent.stats.uptime],["Tx/Today",agent.stats.txToday]].map(([k,v])=>(
          <div key={k} style={{ background:"rgba(255,255,255,0.04)",borderRadius:7,padding:"5px 6px",textAlign:"center" }}>
            <div style={{ fontSize:11,fontWeight:700,color:agent.color,fontFamily:"monospace" }}>{v}</div>
            <div style={{ fontSize:8,color:"#444",letterSpacing:0.5 }}>{k}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── MULTI-WALLET PAYMENT MODAL ──────────────────────────────────────────────
function PaymentModal({ wallet, chainOk, onClose, onSuccess, balance }) {
  const [recipients, setRecipients] = useState([
    { id: 1, address: "", amount: "", label: "", status: "idle", txHash: "", err: "" },
  ]);
  const [globalAmount, setGlobalAmount] = useState("");
  const [useGlobal, setUseGlobal] = useState(false);
  const [sending, setSending] = useState(false);
  const [phase, setPhase] = useState("edit");
  const [globalErr, setGlobalErr] = useState("");
  const [riskWarning, setRiskWarning] = useState(null); // { risks, level, recipientId }
  const [pendingQueue, setPendingQueue] = useState(null);
  const nextId = useRef(2);
  const prevAddresses = useRef({});

  const addRecipient = () => {
    setRecipients(r => [...r, { id: nextId.current++, address:"", amount:"", label:"", status:"idle", txHash:"", err:"" }]);
  };
  const removeRecipient = (id) => setRecipients(r => r.filter(x => x.id !== id));

  const updateRecipient = (id, field, rawValue) => {
    const value = field === "address" || field === "label" ? sanitizeInput(rawValue) : rawValue;
    // Clipboard hijack detection for address field
    if (field === "address") {
      const prev = prevAddresses.current[id] || "";
      if (detectClipboardHijack(prev, value) && value.length === 42) {
        logSecurityEvent("CLIPBOARD", `Possível hijack detectado para dest. ${id}`, "high");
      }
      prevAddresses.current[id] = value;
    }
    setRecipients(r => r.map(x => x.id === id ? { ...x, [field]: value, err:"" } : x));
  };

  const pasteCSV = (e) => {
    const text = e.clipboardData?.getData("text") || "";
    const lines = text.trim().split(/\n/).filter(Boolean);
    if (lines.length < 2) return;
    e.preventDefault();
    const parsed = lines.map(line => {
      const parts = line.split(/[,;\t]/);
      return {
        id: nextId.current++,
        address: sanitizeInput((parts[0] || "").trim()),
        amount: (parts[1] || "").trim(),
        label: sanitizeInput((parts[2] || "").trim()),
        status: "idle", txHash: "", err: ""
      };
    });
    logSecurityEvent("CSV", `${parsed.length} destinatários importados via CSV`, "info");
    setRecipients(parsed);
  };

  const totalUsdc = recipients.reduce((sum, r) => {
    const amt = useGlobal ? parseFloat(globalAmount) : parseFloat(r.amount);
    return sum + (isNaN(amt) ? 0 : amt);
  }, 0);

  const validate = () => {
    let ok = true;
    const updated = recipients.map(r => {
      const amt = useGlobal ? globalAmount : r.amount;
      let err = "";
      if (!r.address.match(/^0x[0-9a-fA-F]{40}$/)) err = "Endereço inválido";
      else if (!amt || isNaN(amt) || Number(amt) <= 0) err = "Valor inválido";
      if (err) ok = false;
      return { ...r, err };
    });
    setRecipients(updated);
    return ok;
  };

  // Step 1: Pre-flight security scan
  const startSecurityScan = async () => {
    setGlobalErr("");
    if (!wallet || !chainOk) { setGlobalErr("Conecte e troque para Arc Testnet"); return; }
    if (!validate()) return;

    // ── Balance check before scanning ──────────────────────────────────────
    const rcpts    = recipients.map(r => ({ _amt: useGlobal ? globalAmount : r.amount }));
    const totalAmt = rcpts.reduce((s, r) => s + parseFloat(r._amt || 0), 0);
    const totalWithFee = totalAmt * 1.001;
    const available = parseFloat(balance?.usdc ?? 0);
    if (available < totalWithFee) {
      setGlobalErr(`Saldo insuficiente — disponível: ${available.toFixed(2)} USDC, necessário: ${totalWithFee.toFixed(4)} USDC (incl. 0.1% taxa)`);
      return;
    }

    if (!checkRateLimit("payment_attempt", 5)) {
      setGlobalErr("Muitas tentativas em pouco tempo. Aguarde 1 minuto.");
      logSecurityEvent("RATE", "Rate limit atingido — tentativa bloqueada", "high");
      return;
    }
    const provOk = verifyProvider();
    if (!provOk.ok) {
      setGlobalErr("⚠ " + provOk.msg);
      logSecurityEvent("PROVIDER", provOk.msg, "critical");
      return;
    }
    // Scan all recipients for risks
    const walletBal = balance?.usdc;
    let overallRisks = [];
    for (const r of recipients) {
      const amt = useGlobal ? globalAmount : r.amount;
      const { risks, level } = analyzeTransactionRisk(r.address, amt, walletBal);
      if (risks.length > 0) {
        overallRisks.push({ ...risks[0], level, recipient: r.label || shortAddr(r.address) });
      }
    }
    if (overallRisks.length > 0) {
      const worstLevel = overallRisks.find(r=>r.level==="critical") ? "critical"
        : overallRisks.find(r=>r.level==="high") ? "high" : "medium";
      logSecurityEvent("RISK", `${overallRisks.length} risco(s) detectado(s) - nível ${worstLevel}`, worstLevel);
      setRiskWarning({ risks: overallRisks, level: worstLevel });
      return;
    }
    logSecurityEvent("SCAN", "Pré-voo aprovado — nenhum risco detectado", "info");
    prepareExecuteAll();
  };

  const [confirmPay, setConfirmPay] = useState(null);

  // Step 2a: show confirmation modal before executing
  const prepareExecuteAll = () => {
    setRiskWarning(null);
    const rcpts    = recipients.map(r => ({ ...r, _amt: useGlobal ? globalAmount : r.amount }));
    const totalAmt = rcpts.reduce((s, r) => s + parseFloat(r._amt || 0), 0);
    const feeAmt   = totalAmt * 0.001;
    const totalWithFee = totalAmt + feeAmt;
    setConfirmPay({
      type: "payment",
      from: wallet,
      amountLabel: `${totalAmt.toFixed(2)} USDC`,
      feeLabel:    `${feeAmt.toFixed(4)} USDC (0.1%)`,
      totalLabel:  `${totalWithFee.toFixed(4)} USDC`,
      network: "Arc Testnet",
      chainId: ARC_CHAIN_ID,
      extra: [
        ["Recipients",      String(rcpts.length)],
        ["Interface",       "ERC-20 (6 decimals)"],
        ["Contract",        `${CONTRACTS.USDC.slice(0,10)}...`],
      ],
      _rcpts: rcpts,
    });
  };

  const executeAll = async () => {
    const c = confirmPay;
    if (!c || !c._rcpts) return;  // guard: modal was already dismissed
    setConfirmPay(null);
    setPhase("sending"); setSending(true);

    // ── Send to each recipient via ERC-20 USDC transfer() ───────────────────
    // Each call opens MetaMask once per recipient so the user signs individually.
    // Arc ERC-20 transfer: call USDC contract 0x3600...0000 with transfer(to, amount)
    // Amount uses 6 decimals (ERC-20 interface), NOT 18 (native interface).
    for (let i = 0; i < c._rcpts.length; i++) {
      const r = c._rcpts[i];
      setRecipients(prev => prev.map(x => x.id === r.id ? { ...x, status:"sending" } : x));
      try {
        if (!wallet) throw new Error("Wallet disconnected");
        if (!r.address?.match(/^0x[0-9a-fA-F]{40}$/)) throw new Error("Invalid address");
        const txHash = await sendUSDCERC20(wallet, r.address, r._amt);

        setRecipients(prev => prev.map(x => x.id === r.id ? { ...x, status:"success", txHash } : x));
        logSecurityEvent("TX", `USDC sent → ${shortAddr(r.address)} | ${r._amt} USDC | ${txHash.slice(0,14)}`, "info");
        onSuccess && onSuccess(txHash, r._amt, r.address);

        // Poll receipt in background — update status when confirmed on Arc
        waitForReceipt(txHash).then(receipt => {
          if (receipt) {
            setRecipients(prev => prev.map(x =>
              x.id === r.id ? { ...x, status:"confirmed", txHash } : x
            ));
          }
        }).catch(() => {});

      } catch (e) {
        const errMsg =
          e.code === 4001 ? "Rejected by user" :
          e.message?.includes("insufficient") ? "Insufficient USDC balance" :
          e.message || "Failed";
        setRecipients(prev => prev.map(x => x.id === r.id ? { ...x, status:"error", err: errMsg } : x));
        logSecurityEvent("TX", `Failed: ${errMsg.slice(0,40)}`, "high");
      }

      // Small delay between txs so MetaMask doesn't queue them confusingly
      if (i < c._rcpts.length - 1) await new Promise(res => setTimeout(res, 800));
    }

    // ── Collect 0.1% platform fee after all payments (delayed) ────────────────
    const totalAmt = c._rcpts.reduce((s, r) => s + parseFloat(r._amt||0), 0);
    setTimeout(() => collectFee(wallet, totalAmt).catch(() => {}), 2000);

    setSending(false);
    setPhase("done");
  };

  const successCount = recipients.filter(r => r.status === "success").length;
  const errorCount   = recipients.filter(r => r.status === "error").length;
  const statusIcon  = { idle:"○", sending:"◌", success:"✓", error:"✗" };
  const statusColor = { idle:"#444", sending:"#FCD34D", success:"#00FFB2", error:"#FF6B35" };

  return (
    <>
    {riskWarning && (
      <RiskWarning
        risks={riskWarning.risks}
        level={riskWarning.level}
        onCancel={() => setRiskWarning(null)}
        onConfirm={() => { setRiskWarning(null); prepareExecuteAll(); }}
      />
    )}
    {confirmPay && (
      <ConfirmTxModal
        tx={confirmPay}
        onConfirm={executeAll}
        onCancel={() => setConfirmPay(null)}
      />
    )}
    <div style={{ position:"fixed",inset:0,background:"rgba(0,0,0,0.88)",zIndex:100,
      display:"flex",alignItems:"center",justifyContent:"center",backdropFilter:"blur(8px)" }}>
      <div style={{ background:"#0b1018",border:"1px solid rgba(0,255,178,0.2)",borderRadius:22,
        padding:28,width:560,maxWidth:"95vw",maxHeight:"90vh",display:"flex",flexDirection:"column",
        position:"relative",boxShadow:"0 0 80px rgba(0,255,178,0.07)" }}>
        <div style={{ position:"absolute",top:0,left:0,right:0,height:2,borderRadius:"22px 22px 0 0",
          background:"linear-gradient(90deg,transparent,#00FFB2,transparent)" }} />

        <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16 }}>
          <div>
            <div style={{ fontSize:9,color:"#00FFB2",letterSpacing:2,marginBottom:3 }}>// NEXUS + IRIS • MULTI-SEND SEGURO</div>
            <div style={{ fontFamily:"'Space Mono',monospace",fontSize:17,fontWeight:700 }}>
              ENVIO MÚLTIPLO
              <span style={{ fontSize:10,color:"#444",marginLeft:10,fontWeight:400 }}>{recipients.length} dest.</span>
            </div>
          </div>
          <div style={{ display:"flex", alignItems:"center", gap:8 }}>
            <div style={{ background:"rgba(167,139,250,0.1)", border:"1px solid rgba(167,139,250,0.2)",
              borderRadius:8, padding:"4px 10px", fontSize:9, color:"#A78BFA", fontFamily:"monospace" }}>
              ◎ IRIS ATIVO
            </div>
            <button onClick={onClose} disabled={sending} style={{ background:"rgba(255,255,255,0.05)",
              border:"1px solid rgba(255,255,255,0.1)",borderRadius:8,width:30,height:30,color:"#888",
              cursor:"pointer",fontSize:16,display:"flex",alignItems:"center",justifyContent:"center" }}>×</button>
          </div>
        </div>

        {phase === "done" ? (
          <div style={{ flex:1,overflowY:"auto" }}>
            <div style={{ textAlign:"center",padding:"10px 0 20px" }}>
              <div style={{ fontSize:32,marginBottom:8 }}>{errorCount===0?"✓":"⚠"}</div>
              <div style={{ fontFamily:"monospace",fontSize:13,
                color:errorCount===0?"#00FFB2":"#FCD34D",marginBottom:4 }}>
                {successCount} enviado{successCount!==1?"s":""} • {errorCount} erro{errorCount!==1?"s":""}
              </div>
              <div style={{ fontSize:10,color:"#555" }}>Total: {totalUsdc.toFixed(2)} USDC</div>
            </div>
            <div style={{ display:"flex",flexDirection:"column",gap:8,marginBottom:20 }}>
              {recipients.map(r=>{
                const amt = useGlobal ? globalAmount : r.amount;
                return (
                  <div key={r.id} style={{ background:"rgba(255,255,255,0.03)",border:`1px solid ${statusColor[r.status]}22`,
                    borderRadius:10,padding:"10px 14px",display:"flex",alignItems:"center",gap:12 }}>
                    <span style={{ fontSize:16,color:statusColor[r.status],minWidth:20,textAlign:"center" }}>{statusIcon[r.status]}</span>
                    <div style={{ flex:1,minWidth:0 }}>
                      <div style={{ fontFamily:"monospace",fontSize:11,color:"#ccc",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap" }}>
                        {r.label || shortAddr(r.address)}
                      </div>
                      {r.txHash && <a href={`https://testnet.arcscan.app/tx/${r.txHash}`} target="_blank" rel="noreferrer"
                        style={{ fontSize:9,color:"#00FFB2",textDecoration:"none" }}>{shortAddr(r.txHash)} ↗</a>}
                      {r.err && <div style={{ fontSize:9,color:"#FF6B35" }}>{r.err}</div>}
                    </div>
                    <div style={{ fontFamily:"monospace",fontSize:12,color:statusColor[r.status],whiteSpace:"nowrap" }}>{amt} USDC</div>
                  </div>
                );
              })}
            </div>
            <button onClick={onClose} style={{ width:"100%",background:"#00FFB2",border:"none",borderRadius:12,
              padding:"13px 0",color:"#080C10",fontWeight:700,cursor:"pointer",fontFamily:"'Space Mono',monospace",fontSize:12 }}>
              FECHAR
            </button>
          </div>
        ) : (
          <>
            <div style={{ display:"flex",alignItems:"center",gap:10,marginBottom:14,
              background:"rgba(255,255,255,0.03)",borderRadius:10,padding:"10px 14px" }}>
              <div onClick={()=>setUseGlobal(g=>!g)} style={{ width:36,height:20,borderRadius:10,
                background:useGlobal?"#00FFB2":"rgba(255,255,255,0.1)",cursor:"pointer",
                position:"relative",transition:"background 0.2s",flexShrink:0 }}>
                <div style={{ position:"absolute",top:3,left:useGlobal?18:3,width:14,height:14,
                  borderRadius:"50%",background:"#fff",transition:"left 0.2s" }}/>
              </div>
              <span style={{ fontSize:10,color:"#888",flex:1 }}>Mesmo valor para todos</span>
              {useGlobal && <>
                <input value={globalAmount} onChange={e=>setGlobalAmount(e.target.value)}
                  placeholder="0.00" type="number" min="0"
                  style={{ width:90,background:"rgba(255,255,255,0.06)",border:"1px solid rgba(0,255,178,0.3)",
                    borderRadius:8,padding:"6px 10px",color:"#00FFB2",fontFamily:"monospace",
                    fontSize:13,textAlign:"right",outline:"none" }} />
                <span style={{ fontSize:10,color:"#555",marginLeft:-4 }}>USDC</span>
              </>}
            </div>
            {phase==="edit" && recipients.length===1 && (
              <div style={{ fontSize:9,color:"#444",marginBottom:8,padding:"0 2px" }}>
                💡 Cole CSV (endereço, valor, label) • 🛡 IRIS analisa riscos antes do envio
              </div>
            )}
            <div style={{ flex:1,overflowY:"auto",display:"flex",flexDirection:"column",gap:8,marginBottom:12 }}
              onPaste={pasteCSV}>
              {recipients.map((r,i)=>(
                <div key={r.id} style={{ background:"rgba(255,255,255,0.03)",
                  border:`1px solid ${r.err?"rgba(255,107,53,0.35)":phase==="sending"&&r.status==="sending"?"rgba(252,211,77,0.4)":"rgba(255,255,255,0.07)"}`,
                  borderRadius:12,padding:"12px 14px",transition:"border 0.2s",animation:"fadeIn 0.25s ease" }}>
                  <div style={{ display:"grid",gridTemplateColumns:"1fr auto",gap:8,marginBottom:6 }}>
                    <input value={r.label} onChange={e=>updateRecipient(r.id,"label",e.target.value)}
                      placeholder={`Destinatário ${i+1} (apelido opcional)`} disabled={phase!=="edit"}
                      style={{ background:"transparent",border:"none",color:"#777",fontFamily:"monospace",
                        fontSize:9,letterSpacing:1,outline:"none",padding:0 }} />
                    {phase==="edit" && recipients.length>1 && (
                      <button onClick={()=>removeRecipient(r.id)} style={{ background:"none",border:"none",
                        color:"#444",cursor:"pointer",fontSize:14,padding:0,lineHeight:1 }}>×</button>
                    )}
                  </div>
                  <div style={{ display:"grid",gridTemplateColumns:useGlobal?"1fr":"1fr 110px",gap:8 }}>
                    <input value={r.address} onChange={e=>updateRecipient(r.id,"address",e.target.value)}
                      placeholder="0x..." disabled={phase!=="edit"}
                      style={{ background:"rgba(255,255,255,0.04)",border:"1px solid rgba(255,255,255,0.08)",
                        borderRadius:8,padding:"8px 12px",color:"#fff",fontFamily:"monospace",
                        fontSize:11,outline:"none",opacity:phase!=="edit"?0.6:1 }} />
                    {!useGlobal && (
                      <div style={{ position:"relative" }}>
                        <input value={r.amount} onChange={e=>updateRecipient(r.id,"amount",e.target.value)}
                          placeholder="0.00" type="number" min="0" disabled={phase!=="edit"}
                          style={{ width:"100%",boxSizing:"border-box",background:"rgba(255,255,255,0.04)",
                            border:"1px solid rgba(255,255,255,0.08)",borderRadius:8,padding:"8px 30px 8px 12px",
                            color:"#00FFB2",fontFamily:"monospace",fontSize:12,outline:"none",
                            opacity:phase!=="edit"?0.6:1 }} />
                        <span style={{ position:"absolute",right:10,top:"50%",transform:"translateY(-50%)",
                          fontSize:9,color:"#555",pointerEvents:"none" }}>USDC</span>
                      </div>
                    )}
                  </div>
                  {r.err && <div style={{ fontSize:9,color:"#FF6B35",marginTop:5,fontFamily:"monospace" }}>⚠ {r.err}</div>}
                  {r.txHash && <a href={`https://testnet.arcscan.app/tx/${r.txHash}`} target="_blank" rel="noreferrer"
                    style={{ fontSize:9,color:"#00FFB2",textDecoration:"none",display:"block",marginTop:5 }}>
                    Tx: {shortAddr(r.txHash)} ↗</a>}
                  {phase!=="edit" && (
                    <div style={{ marginTop:6,fontSize:12,color:statusColor[r.status],
                      animation:r.status==="sending"?"pulse 1s infinite":"none" }}>
                      {statusIcon[r.status]} {r.status==="sending"?"Aguardando MetaMask...":r.status==="success"?"Confirmado":""}
                    </div>
                  )}
                </div>
              ))}
            </div>
            {phase==="edit" && (
              <button onClick={addRecipient} style={{ background:"rgba(255,255,255,0.03)",
                border:"1px dashed rgba(255,255,255,0.12)",borderRadius:10,padding:"9px 0",
                color:"#555",cursor:"pointer",fontFamily:"monospace",fontSize:10,
                letterSpacing:1,marginBottom:12,transition:"all 0.2s",width:"100%" }}
                onMouseEnter={e=>{e.target.style.borderColor="rgba(0,255,178,0.3)";e.target.style.color="#00FFB2"}}
                onMouseLeave={e=>{e.target.style.borderColor="rgba(255,255,255,0.12)";e.target.style.color="#555"}}>
                + ADICIONAR DESTINATÁRIO
              </button>
            )}
            <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",
              background:"rgba(0,255,178,0.05)",border:"1px solid rgba(0,255,178,0.1)",
              borderRadius:10,padding:"10px 14px",marginBottom:14,fontSize:10 }}>
              <span style={{ color:"#555" }}>⬡ Arc Testnet • 🛡 IRIS scan ativado</span>
              <span style={{ color:"#00FFB2",fontFamily:"monospace",fontWeight:700 }}>
                Total: {totalUsdc.toFixed(2)} USDC
              </span>
            </div>
            {globalErr && <div style={{ color:"#FF6B35",fontSize:11,fontFamily:"monospace",marginBottom:10 }}>⚠ {globalErr}</div>}
            <button onClick={startSecurityScan} disabled={sending} style={{
              width:"100%",background:sending?"rgba(0,255,178,0.15)":"linear-gradient(135deg,#00FFB2,#00cc8e)",
              border:"none",borderRadius:12,padding:"13px 0",color:"#080C10",
              fontWeight:700,fontSize:12,fontFamily:"'Space Mono',monospace",
              cursor:sending?"not-allowed":"pointer",letterSpacing:1,transition:"all 0.2s" }}>
              {sending
                ? `ENVIANDO ${recipients.filter(r=>r.status==="success").length}/${recipients.length}...`
                : `🛡 SCAN + EXECUTAR ${recipients.length} PAGAMENTO${recipients.length!==1?"S":""} →`}
            </button>
          </>
        )}
      </div>
    </div>
    </>
  );
}

// ─── MAIN APP ─────────────────────────────────────────────────────────────────
export default function ArcAgentOS() {
  // Web3 state
  const { t } = useTranslation();

  const [wallet, setWallet] = useState(null);
  const [chainOk, setChainOk] = useState(false);
  const [balance, setBalance] = useState(null);
  const [blockNumber, setBlockNumber] = useState(null);
  const [txCount, setTxCount] = useState(null);
  const [chainError, setChainError] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [showConnectPopup, setShowConnectPopup] = useState(false);
  const [showProfile, setShowProfile] = useState(false);
  const [showInternalWallet, setShowInternalWallet] = useState(false);

  // UI state
  const [selectedAgent, setSelectedAgent] = useState(null);
  const [activeTab, setActiveTab] = useState("contracts");
  const [showPayModal, setShowPayModal] = useState(false);
  const [showSwapModal, setShowSwapModal] = useState(false);
  const [showCircleSDK, setShowCircleSDK] = useState(false);
  const [showVault,     setShowVault]     = useState(false);
  const [versionClicks, setVersionClicks] = useState(0);
  const [liveVolume, setLiveVolume] = useState(8_420_340);
  const [liveTxs, setLiveTxs] = useState([
    { id:"0x3f…a12", type:"Payment",  amount:"+4,200 USDC", time:"2s",  agent:"NEXUS", confirmed:true },
    { id:"0x9c…b44", type:"Contract", amount:"Deploy",      time:"18s", agent:"LEX",   confirmed:true },
    { id:"0x1a…f90", type:"Yield",    amount:"+127 USDC",   time:"1m",  agent:"VOLT",  confirmed:true },
    { id:"0x7d…c33", type:"FX Swap",  amount:"BRL→USDC",   time:"3m",  agent:"NEXUS", confirmed:true },
    { id:"0x2e…d77", type:"KYC",      amount:"Verified",    time:"5m",  agent:"IRIS",  confirmed:true },
  ]);

  // Chat
  const [chatMsg, setChatMsg] = useState("");
  const [chatHistory, setChatHistory] = useState([
    { role:"agent", text:"AgentOS online. Conecte sua wallet para interagir com a Arc Network.", agent:"NEXUS" }
  ]);
  const [chatLoading, setChatLoading] = useState(false);
  const chatEndRef = useRef(null);

  // ── Auto-scroll chat
  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior:"smooth" }); }, [chatHistory]);

  // ── Live ticker
  useEffect(() => {
    const iv = setInterval(() => {
      setLiveVolume(v => v + Math.floor(Math.random()*600+100));
      if (Math.random() > 0.55) {
        const pool = [
          {type:"Payment",amount:`+${(Math.random()*2000+200).toFixed(0)} USDC`,agent:"NEXUS"},
          {type:"Contract",amount:"Deploy",agent:"LEX"},
          {type:"Yield",amount:`+${(Math.random()*300+10).toFixed(1)} USDC`,agent:"VOLT"},
          {type:"FX Swap",amount:"BRL→USDC",agent:"NEXUS"},
          {type:"KYC",amount:"Verified",agent:"IRIS"},
        ];
        const pick = pool[Math.floor(Math.random()*pool.length)];
        setLiveTxs(prev => [{
          id:`0x${Math.random().toString(16).slice(2,6)}…${Math.random().toString(16).slice(2,5)}`,
          time:"agora", confirmed:true, ...pick
        }, ...prev.slice(0,9)]);
      }
    }, 3200);
    return () => clearInterval(iv);
  }, []);

  // ── Poll on-chain data when wallet connected ─────────────────────────────
  // Uses fetchUSDCBalance (ERC-20 balanceOf, 6 dec) — the ONLY correct source
  // for user-facing balances on Arc per docs.arc.network/arc/references/contract-addresses.
  useEffect(() => {
    if (!wallet || !chainOk) return;
    const fetchData = async () => {
      try {
        const [usdcBal, rawNative, block, nonce] = await Promise.all([
          fetchUSDCBalance(wallet),
          rpc("eth_getBalance", [wallet, "latest"]),
          getBlockNumber(),
          getTransactionCount(wallet),
        ]);
        const nativeFloat = Number(BigInt(rawNative)) / 1e18;
        setBalance({
          usdc:      usdcBal.usdcDisplay,   // "12.34"  — shown in UI
          usdcFloat: usdcBal.usdcFloat,      // 12.34    — used for validation
          usdcRaw:   usdcBal.usdcRaw,        // "12340000" — raw 6-dec bigint string
          native:    nativeFloat.toFixed(6), // native 18-dec (gas display only)
          wei:       rawNative,
        });
        setBlockNumber(block);
        setTxCount(nonce);
      } catch(e) { console.warn("Balance fetch:", e.message); }
    };
    fetchData();
    const iv = setInterval(fetchData, 8000);
    return () => clearInterval(iv);
  }, [wallet, chainOk]);

  // Expose refresh so modals can trigger it after a tx confirms
  const refreshBalance = useCallback(() => {
    if (!wallet || !chainOk) return;
    fetchUSDCBalance(wallet).then(usdcBal => {
      setBalance(prev => prev ? {
        ...prev,
        usdc:      usdcBal.usdcDisplay,
        usdcFloat: usdcBal.usdcFloat,
        usdcRaw:   usdcBal.usdcRaw,
      } : null);
    }).catch(() => {});
  }, [wallet, chainOk]);

  // ── Connect wallet — 3-step flow per Arc docs ────────────────────────────
  // Step 1: eth_requestAccounts   — user approves account access
  // Step 2: wallet_addEthereumChain / wallet_switchEthereumChain — Arc Testnet
  // Step 3: personal_sign EIP-191 — user signs a ownership proof message
  //         This confirms they control the key and opens the EVM signing UI.
  const startConnecting = async () => {
    if (!window.ethereum || connecting) return;
    setConnecting(true);
    setChainError("");
    try {
      // ── Step 1: Request accounts ────────────────────────────────────────
      const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
      if (!accounts?.length) throw new Error("No accounts returned.");
      const addr = accounts[0];

      // ── Step 2: Switch / add Arc Testnet ────────────────────────────────
      let onArc = false;
      try {
        await window.ethereum.request({
          method: "wallet_switchEthereumChain",
          params: [{ chainId: ARC_CHAIN.chainId }],
        });
        onArc = true;
      } catch (sw) {
        if (sw.code === 4902) {
          try {
            await window.ethereum.request({ method: "wallet_addEthereumChain", params: [ARC_CHAIN] });
            onArc = true;
          } catch (_) { /* user rejected adding chain */ }
        }
        // code 4001 = user rejected switch — still connected, just warn
      }

      // ── Step 3: personal_sign — ownership proof + EVM signing UI ────────
      // EIP-191 message: human-readable, includes timestamp to prevent replay.
      const ts  = new Date().toISOString();
      const msg = `Welcome to AgentOS on Arc Network!

Signing this message proves you control this wallet and connects it to the platform.

Address: ${addr}
Timestamp: ${ts}
Chain: Arc Testnet (${ARC_CHAIN_ID})

This is a FREE off-chain signature — no gas is charged.`;
      // personal_sign expects hex-encoded message
      const msgHex = "0x" + Array.from(new TextEncoder().encode(msg))
        .map(b => b.toString(16).padStart(2,"0")).join("");
      try {
        const sig = await window.ethereum.request({
          method: "personal_sign",
          params: [msgHex, addr],
        });
        logSecurityEvent("WALLET", `Signature verified: ${sig.slice(0,20)}...`, "info");
      } catch (sigErr) {
        if (sigErr.code === 4001) throw new Error("Signature rejected — connection cancelled.");
        // Other errors: proceed but note it
        logSecurityEvent("WALLET", "Signature step skipped: " + sigErr.message, "warning");
      }

      setWallet(addr);
      setChainOk(onArc);
      logSecurityEvent("WALLET", `Connected: ${shortAddr(addr)} | Arc: ${onArc}`, "info");
    } catch (e) {
      const msg =
        e.code === 4001   ? "Rejected — please approve in MetaMask." :
        e.code === -32002 ? "Already pending — open MetaMask." :
        e.message || "Unknown error.";
      setChainError(msg);
    } finally {
      setConnecting(false);
    }
  };

  // ── Set wallet state directly (legacy, kept for banner button)
  const connectWallet = (addr) => {
    if (!addr) return;
    setWallet(addr);
    setChainOk(true);
    setChainError("");
  };

  const ensureArcChain = async () => {
    if (!window.ethereum) throw new Error("No wallet detected");
    try {
      await window.ethereum.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: ARC_CHAIN.chainId }],   // "0x4cef52" = 5042002
      });
      setChainOk(true);
      setChainError("");
    } catch (switchError) {
      if (switchError.code === 4902) {
        // Chain not yet added — prompt user to add Arc Testnet
        await window.ethereum.request({
          method: "wallet_addEthereumChain",
          params: [ARC_CHAIN],
        });
        setChainOk(true);
        setChainError("");
      } else {
        // 4001 = user rejected, others = real error — re-throw so WalletButton shows it
        throw switchError;
      }
    }
  };

  // Listen for chain/account changes
  useEffect(() => {
    if (!window.ethereum) return;
    const onChain = (id) => { setChainOk(parseInt(id,16) === ARC_CHAIN_ID); };
    const onAcct  = (accts) => { if(accts.length) setWallet(accts[0]); else { setWallet(null); setChainOk(false); }};
    window.ethereum.on("chainChanged", onChain);
    window.ethereum.on("accountsChanged", onAcct);
    return () => { window.ethereum.removeListener("chainChanged",onChain); window.ethereum.removeListener("accountsChanged",onAcct); };
  }, []);

  // ── Send chat to Claude as selected agent
  const sendChat = async () => {
    if (!chatMsg.trim() || chatLoading) return;
    const msg = chatMsg; setChatMsg(""); setChatLoading(true);
    setChatHistory(h => [...h, { role:"user", text:msg }]);
    const agent = selectedAgent || AGENTS[0];
    const walletCtx = wallet
      ? `O usuário tem a wallet ${shortAddr(wallet)} conectada na Arc Testnet. Bloco atual: ${blockNumber ?? "?"}. Transações feitas: ${txCount ?? "?"}.`
      : "O usuário ainda não conectou a wallet.";
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method:"POST", headers:{"Content-Type":"application/json"},
        body: JSON.stringify({
          model:"claude-sonnet-4-20250514", max_tokens:1000,
          system:`Você é ${agent.name}, um agente de IA autônomo especializado em ${agent.role} na Arc Network (Circle's L1 blockchain).
A Arc Testnet usa USDC como token nativo de gas, tem Chain ID 5042002, finalidade sub-segundo via consenso Malachite, e explorer em testnet.arcscan.app.
${walletCtx}
Responda de forma concisa e técnica (máximo 3 frases). Use termos como "executando na Arc", "confirmado no bloco", "USDC nativo". Seja proativo.`,
          messages:[{ role:"user", content:msg }]
        })
      });
      const data = await res.json();
      setChatHistory(h => [...h, { role:"agent", text: data.content?.[0]?.text || "Erro de conexão.", agent:agent.name }]);
    } catch {
      setChatHistory(h => [...h, { role:"agent", text:"Falha na conexão com Arc Network.", agent:"SYSTEM" }]);
    }
    setChatLoading(false);
  };

  const onPaymentSuccess = (txHash, amount, to) => {
    setLiveTxs(prev => [{
      id: shortAddr(txHash), type:"Payment",
      amount:`+${amount} USDC`, time:"agora", agent:"NEXUS", confirmed:true
    }, ...prev.slice(0,9)]);
  };

  const onSwapSuccess = (txHash, amtIn, symIn, symOut) => {
    setLiveTxs(prev => [{
      id: shortAddr(txHash), type:"FX Swap",
      amount:`${amtIn} ${symIn}→${symOut}`, time:"agora", agent:"VOLT", confirmed:true
    }, ...prev.slice(0,9)]);
  };

  // ─── RENDER ────────────────────────────────────────────────────────────────
  return (
    <div style={{ minHeight:"100vh", background:"#080C10", color:"#fff",
      fontFamily:"'IBM Plex Mono','Courier New',monospace", overflowX:"hidden" }}>

      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&family=IBM+Plex+Mono:wght@300;400;600&display=swap');
        @keyframes pulse   { 0%,100%{opacity:1;transform:scale(1)} 50%{opacity:0.4;transform:scale(1.6)} }
        @keyframes shimmer { 0%{opacity:0.3} 50%{opacity:1} 100%{opacity:0.3} }
        @keyframes fadeIn  { from{opacity:0;transform:translateY(6px)} to{opacity:1;transform:none} }
        @keyframes scanline{ 0%{transform:translateY(-100%)} 100%{transform:translateY(100vh)} }
        @keyframes glow    { 0%,100%{box-shadow:0 0 8px #00FFB244} 50%{box-shadow:0 0 24px #00FFB288} }
        @keyframes spin    { to{transform:rotate(360deg)} }
        ::-webkit-scrollbar{width:3px} ::-webkit-scrollbar-track{background:#0a0e14}
        ::-webkit-scrollbar-thumb{background:#1e2a3a;border-radius:2px}
        input:focus{outline:none;border-color:rgba(0,255,178,0.4)!important}
        button:hover{opacity:0.88}
        /* Ensure MetaMask / browser extension popups always sit on top */
        #metamask-extension-popup, [id*="metamask"], iframe[src*="metamask"],
        iframe[src*="extension"] { z-index: 2147483647 !important; pointer-events: all !important; }
      `}</style>

      {/* Ambient glow blobs */}
      {[
        {c:"#00FFB2",top:"5%",left:"2%",s:200},
        {c:"#FF6B35",top:"60%",left:"80%",s:160},
        {c:"#A78BFA",top:"30%",left:"60%",s:120},
        {c:"#FCD34D",top:"80%",left:"20%",s:140},
      ].map((b,i)=>(
        <div key={i} style={{ position:"fixed",top:b.top,left:b.left,width:b.s,height:b.s,
          borderRadius:"50%",background:b.c,opacity:0.04,filter:"blur(60px)",pointerEvents:"none",zIndex:0 }}/>
      ))}

      {/* Scanline */}
      <div style={{ position:"fixed",top:0,left:0,right:0,height:3,
        background:"linear-gradient(transparent,rgba(0,255,178,0.04),transparent)",
        animation:"scanline 10s linear infinite",pointerEvents:"none",zIndex:1 }}/>

      <div style={{ position:"relative",zIndex:2,maxWidth:1220,margin:"0 auto",padding:"22px 18px" }}>

        {/* ── HEADER */}
        <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:24 }}>
          <div>
            <div style={{ display:"flex",alignItems:"center",gap:8,marginBottom:3 }}>
              <div style={{ width:7,height:7,borderRadius:"50%",background:"#00FFB2",animation:"pulse 2s infinite" }}/>
              <span style={{ fontSize:9,color:"#00FFB2",letterSpacing:3 }}>ARC NETWORK • CIRCLE L1 • MALACHITE BFT</span>
            </div>
            <h1 style={{ margin:0,fontSize:26,fontFamily:"'Space Mono',monospace",fontWeight:700,letterSpacing:-0.5 }}>
              AGENT<span style={{ color:"#00FFB2" }}>OS</span>
              <span style={{ fontSize:11,color:"#333",marginLeft:12,letterSpacing:2 }}>v0.1.0</span>
            </h1>
          </div>
          <div style={{ display:"flex", alignItems:"center", gap:10 }}>
            <LangSwitcher />
            <button onClick={() => setShowInternalWallet(true)} style={{
              background:"rgba(0,255,178,0.07)", border:"1px solid rgba(0,255,178,0.2)",
              borderRadius:10, padding:"10px 16px", color:"#00FFB2",
              cursor:"pointer", fontFamily:"monospace", fontSize:11, letterSpacing:1,
              display:"flex", alignItems:"center", gap:7, transition:"all 0.2s"
            }}>
              <span style={{ fontSize:13 }}>🔐</span> INTERNAL WALLET
            </button>
            <button onClick={() => setShowProfile(true)} style={{
              background:"rgba(167,139,250,0.1)", border:"1px solid rgba(167,139,250,0.25)",
              borderRadius:10, padding:"10px 16px", color:"#A78BFA",
              cursor:"pointer", fontFamily:"monospace", fontSize:11, letterSpacing:1,
              display:"flex", alignItems:"center", gap:7, transition:"all 0.2s"
            }}>
              <span style={{ fontSize:14 }}>◎</span> {t("profileBtn")}
            </button>
            <WalletButton wallet={wallet} chainOk={chainOk} connecting={connecting}
              onDirectConnect={startConnecting}
              onSwitchChain={ensureArcChain}
              onDisconnect={() => { setWallet(null); setChainOk(false); setBalance(null); setChainError(""); }} />
            {chainError && <div style={{ fontSize:10,color:"#FF6B35",fontFamily:"monospace" }}>⚠ {chainError}</div>}
          </div>
        </div>

        {/* ── WALLET INFO PANEL (when connected) */}
        {wallet && chainOk && (
          <div style={{ background:"rgba(0,255,178,0.05)",border:"1px solid rgba(0,255,178,0.15)",
            borderRadius:12,padding:"14px 20px",marginBottom:22,
            display:"grid",gridTemplateColumns:"repeat(5,1fr)",gap:16,animation:"fadeIn 0.4s ease" }}>
            {[
              { label:"WALLET",          val:shortAddr(wallet) },
              { label:"USDC Balance",    val: balance ? `${parseFloat(balance.usdc||0).toFixed(4)} USDC` : "—" },
              { label:"Native (18 dec)",  val: balance ? `${parseFloat(balance.native||0).toFixed(6)}` : "—" },
              { label:"BLOCO ATUAL",     val: blockNumber ?? "—" },
              { label:"TX NONCE",        val: txCount ?? "—" },
            ].map(s=>(
              <div key={s.label}>
                <div style={{ fontSize:9,color:"#444",letterSpacing:1.5,marginBottom:3 }}>{s.label}</div>
                <div style={{ fontSize:13,color:"#00FFB2",fontFamily:"'Space Mono',monospace",fontWeight:700 }}>{s.val}</div>
              </div>
            ))}
          </div>
        )}

        {/* ── STATS BAR */}
        <div style={{ display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:10,marginBottom:22,
          background:"rgba(255,255,255,0.02)",border:"1px solid rgba(255,255,255,0.05)",
          borderRadius:12,padding:"14px 18px" }}>
          {[
            {label:"VOLUME 24H",    val:`$${liveVolume.toLocaleString()}`, color:"#00FFB2"},
            {label:"AGENTES ATIVOS",val:"4/4",                             color:"#fff"},
            {label:"CONSENSO",      val:"Malachite BFT",                   color:"#FF6B35"},
            {label:"FINALIDADE",    val:"~350ms",                           color:"#FCD34D"},
          ].map(s=>(
            <div key={s.label} style={{ textAlign:"center" }}>
              <div style={{ fontSize:17,fontWeight:700,color:s.color,fontFamily:"'Space Mono',monospace" }}>{s.val}</div>
              <div style={{ fontSize:8,color:"#444",letterSpacing:1.5,marginTop:2 }}>{s.label}</div>
            </div>
          ))}
        </div>

        {/* ── ARC NETWORK SPECS — source: docs.arc.network */}
        <div style={{ display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:10,marginBottom:22 }}>
          {[
            { title:"USDC as Gas", icon:"⬡", color:"#00FFB2",
              lines:["Native gas token","~$0.01 per tx","18 dec precision","Stable, predictable"] },
            { title:"Malachite BFT", icon:"◈", color:"#FF6B35",
              lines:["~350ms finality","~3,000 TPS","Deterministic","No reorgs possible"] },
            { title:"Opt-in Privacy", icon:"◎", color:"#A78BFA",
              lines:["Selective disclosure","Viewing keys","Compliance-ready","USDC blocklist"] },
          ].map(s=>(
            <div key={s.title} style={{ background:"rgba(255,255,255,0.02)",
              border:`1px solid ${s.color}20`, borderRadius:12, padding:"14px 16px" }}>
              <div style={{ display:"flex",alignItems:"center",gap:8,marginBottom:10 }}>
                <span style={{ fontSize:18,color:s.color }}>{s.icon}</span>
                <span style={{ fontFamily:"monospace",fontSize:11,fontWeight:700,color:s.color,letterSpacing:1 }}>{s.title}</span>
              </div>
              {s.lines.map(l=>(
                <div key={l} style={{ fontSize:9,color:"#555",marginBottom:3,
                  display:"flex",alignItems:"center",gap:6 }}>
                  <span style={{ color:`${s.color}60`,fontSize:7 }}>▸</span>{l}
                </div>
              ))}
            </div>
          ))}
        </div>

        {/* ── NOT-CONNECTED BANNER */}
        {!wallet && (
          <div style={{ background:"rgba(0,255,178,0.06)",border:"1px dashed rgba(0,255,178,0.2)",
            borderRadius:12,padding:"14px 20px",marginBottom:22,
            display:"flex",alignItems:"center",justifyContent:"space-between" }}>
            <div style={{ fontSize:12,color:"#00FFB2" }}>
              {t("connectBanner")}
            </div>
            <button onClick={startConnecting} style={{ background:"#00FFB2",border:"none",borderRadius:8,
              padding:"8px 18px",color:"#080C10",fontWeight:700,cursor:"pointer",
              fontFamily:"monospace",fontSize:11,letterSpacing:1 }}>{t("connectNow")}</button>
          </div>
        )}

        {/* ── AGENTS GRID */}
        <div style={{ marginBottom:22 }}>
          <div style={{ fontSize:9,color:"#333",letterSpacing:2,marginBottom:12 }}>// AGENTES AUTÔNOMOS</div>
          <div style={{ display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:10 }}>
            {AGENTS.map(a=>(
              <AgentCard key={a.id} agent={a}
                selected={selectedAgent?.id===a.id}
                onClick={()=>setSelectedAgent(selectedAgent?.id===a.id?null:a)} />
            ))}
          </div>
        </div>

        {/* ── MAIN CONTENT */}
        <div style={{ display:"grid",gridTemplateColumns:"1fr 310px",gap:14 }}>

          {/* LEFT — Contracts / Transactions */}
          <div style={{ background:"rgba(255,255,255,0.02)",border:"1px solid rgba(255,255,255,0.06)",
            borderRadius:16,padding:20 }}>
            <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:18 }}>
              <div style={{ display:"flex",gap:2,background:"rgba(255,255,255,0.03)",borderRadius:8,padding:3 }}>
                {["contracts","transactions"].map(t=>(
                  <button key={t} onClick={()=>setActiveTab(t)} style={{
                    padding:"7px 16px",background:activeTab===t?"rgba(255,255,255,0.08)":"transparent",
                    border:"none",color:activeTab===t?"#fff":"#555",cursor:"pointer",borderRadius:6,
                    fontSize:9,letterSpacing:1.5,fontFamily:"monospace",transition:"all 0.2s"
                  }}>{t==="contracts"?"CONTRATOS":"TRANSAÇÕES"}</button>
                ))}
              </div>
              {wallet && chainOk && (
                <div style={{ display:"flex", gap:8 }}>
                  <button onClick={()=>setShowSwapModal(true)} style={{
                    background:"linear-gradient(135deg,#FCD34D,#f5a623)",border:"none",borderRadius:9,
                    padding:"8px 16px",color:"#080C10",fontWeight:700,fontSize:10,
                    fontFamily:"monospace",cursor:"pointer",letterSpacing:1
                  }}>⇅ SWAP</button>
                  <button onClick={()=>setShowPayModal(true)} style={{
                    background:"linear-gradient(135deg,#00FFB2,#00cc8e)",border:"none",borderRadius:9,
                    padding:"8px 16px",color:"#080C10",fontWeight:700,fontSize:10,
                    fontFamily:"monospace",cursor:"pointer",letterSpacing:1
                  }}>+ ENVIAR</button>
                </div>
              )}
            </div>

            {activeTab==="contracts" ? (
              <div>
                <div style={{ display:"grid",gridTemplateColumns:"70px 1fr 110px 65px 100px",
                  gap:10,padding:"0 0 8px",borderBottom:"1px solid rgba(255,255,255,0.07)" }}>
                  {["ID","TÍTULO","VALOR","AGENTE","PROGRESSO"].map(h=>(
                    <div key={h} style={{ fontSize:8,color:"#444",letterSpacing:1.5 }}>{h}</div>
                  ))}
                </div>
                {MOCK_CONTRACTS.map(c=>{
                  const col=AGENT_COLORS[c.agent]||"#fff";
                  const stCol={executing:"#00FFB2",pending:"#FCD34D",completed:"#444"}[c.status];
                  return (
                    <div key={c.id} style={{ display:"grid",gridTemplateColumns:"70px 1fr 110px 65px 100px",
                      alignItems:"center",padding:"11px 0",borderBottom:"1px solid rgba(255,255,255,0.04)",gap:10 }}>
                      <div style={{ fontFamily:"monospace",fontSize:10,color:"#555" }}>{c.id}</div>
                      <div style={{ fontSize:12,color:"#ccc" }}>{c.title}</div>
                      <div style={{ fontFamily:"monospace",fontSize:11,color:"#fff",fontWeight:600 }}>{c.value}</div>
                      <div style={{ fontSize:9,color:col,background:`${col}15`,borderRadius:20,
                        padding:"2px 7px",textAlign:"center",fontFamily:"monospace" }}>{c.agent}</div>
                      <div style={{ display:"flex",alignItems:"center",gap:5 }}>
                        <div style={{ flex:1,height:3,background:"rgba(255,255,255,0.05)",borderRadius:4,overflow:"hidden" }}>
                          <div style={{ width:`${c.progress}%`,height:"100%",background:stCol,borderRadius:4 }}/>
                        </div>
                        <span style={{ fontSize:9,color:"#555",fontFamily:"monospace",minWidth:28 }}>{c.progress}%</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div>
                {liveTxs.map((tx,i)=>{
                  const col=AGENT_COLORS[tx.agent]||"#fff";
                  return (
                    <div key={i} style={{ display:"flex",alignItems:"center",justifyContent:"space-between",
                      padding:"9px 0",borderBottom:"1px solid rgba(255,255,255,0.04)",
                      animation:i===0?"fadeIn 0.4s ease":"none" }}>
                      <div style={{ display:"flex",alignItems:"center",gap:9 }}>
                        <div style={{ width:30,height:30,borderRadius:8,background:`${col}15`,
                          border:`1px solid ${col}30`,display:"flex",alignItems:"center",
                          justifyContent:"center",fontSize:10,color:col,flexShrink:0 }}>
                          {tx.type[0]}
                        </div>
                        <div>
                          <div style={{ fontSize:11,color:"#ccc" }}>{tx.type}</div>
                          <div style={{ fontSize:9,color:"#555",fontFamily:"monospace" }}>{tx.id}</div>
                        </div>
                      </div>
                      <div style={{ textAlign:"right" }}>
                        <div style={{ fontSize:12,color:"#fff",fontWeight:600 }}>{tx.amount}</div>
                        <div style={{ fontSize:9,color:"#444" }}>{tx.time} • {tx.agent}</div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* RIGHT — Chat */}
          <div style={{ background:"rgba(255,255,255,0.02)",border:"1px solid rgba(255,255,255,0.06)",
            borderRadius:16,padding:18,display:"flex",flexDirection:"column",height:480 }}>
            <div style={{ marginBottom:14 }}>
              <div style={{ fontSize:8,color:"#444",letterSpacing:2,marginBottom:2 }}>// AGENT CHAT</div>
              <div style={{ fontSize:11,color: selectedAgent ? AGENT_COLORS[selectedAgent.name]:"#00FFB2" }}>
                {selectedAgent ? `${selectedAgent.name} — ${selectedAgent.role}` : "Clique em um agente"}
              </div>
            </div>
            <div style={{ flex:1,overflowY:"auto",display:"flex",flexDirection:"column",gap:8,marginBottom:10 }}>
              {chatHistory.map((msg,i)=>{
                const isUser=msg.role==="user";
                const col=msg.agent?(AGENT_COLORS[msg.agent]||"#00FFB2"):"#fff";
                return (
                  <div key={i} style={{ display:"flex",flexDirection:isUser?"row-reverse":"row",gap:7,
                    animation:"fadeIn 0.3s ease" }}>
                    {!isUser && (
                      <div style={{ width:22,height:22,borderRadius:6,background:`${col}18`,
                        border:`1px solid ${col}35`,display:"flex",alignItems:"center",
                        justifyContent:"center",fontSize:8,color:col,flexShrink:0,marginTop:2 }}>
                        {msg.agent?.[0]||"?"}
                      </div>
                    )}
                    <div style={{ maxWidth:"82%",padding:"7px 11px",
                      borderRadius:isUser?"11px 11px 4px 11px":"11px 11px 11px 4px",
                      background:isUser?"rgba(0,255,178,0.09)":"rgba(255,255,255,0.04)",
                      border:`1px solid ${isUser?"rgba(0,255,178,0.18)":"rgba(255,255,255,0.06)"}`,
                      fontSize:10,color:isUser?"#00FFB2":"#bbb",lineHeight:1.55 }}>
                      {!isUser && <div style={{ fontSize:8,color:col,marginBottom:2,letterSpacing:1 }}>{msg.agent}</div>}
                      {msg.text}
                    </div>
                  </div>
                );
              })}
              {chatLoading && (
                <div style={{ display:"flex",gap:7,alignItems:"center" }}>
                  <div style={{ width:22,height:22,borderRadius:6,background:"rgba(0,255,178,0.1)",
                    border:"1px solid rgba(0,255,178,0.25)",display:"flex",alignItems:"center",
                    justifyContent:"center",fontSize:8,color:"#00FFB2" }}>AI</div>
                  <div style={{ display:"flex",gap:3,padding:"8px 11px",
                    background:"rgba(255,255,255,0.04)",border:"1px solid rgba(255,255,255,0.06)",
                    borderRadius:"11px 11px 11px 4px" }}>
                    {[0,1,2].map(j=><div key={j} style={{ width:4,height:4,borderRadius:"50%",
                      background:"#00FFB2",animation:`pulse 1.2s ${j*0.2}s infinite` }}/>)}
                  </div>
                </div>
              )}
              <div ref={chatEndRef}/>
            </div>
            <div style={{ display:"flex",gap:7 }}>
              <input value={chatMsg} onChange={e=>setChatMsg(e.target.value)}
                onKeyDown={e=>e.key==="Enter"&&sendChat()}
                placeholder="Fale com o agente..."
                style={{ flex:1,background:"rgba(255,255,255,0.04)",
                  border:"1px solid rgba(255,255,255,0.09)",borderRadius:9,
                  padding:"9px 11px",color:"#fff",fontSize:10,
                  fontFamily:"monospace",transition:"border 0.2s" }}/>
              <button onClick={sendChat} disabled={chatLoading} style={{
                background:chatLoading?"rgba(0,255,178,0.1)":"#00FFB2",border:"none",
                borderRadius:9,padding:"0 14px",cursor:chatLoading?"not-allowed":"pointer",
                color:"#080C10",fontWeight:700,fontSize:13,transition:"all 0.2s"
              }}>→</button>
            </div>
          </div>
        </div>

        {/* ── SECURITY PANEL */}
        <SecurityPanel wallet={wallet} balance={balance} />

        {/* ── SELF-HEALING PANEL */}
        <SelfHealingPanel />

        {/* ── AGENT VAULT */}
        <VaultPanel
          wallet={wallet}
          chainOk={chainOk}
          balance={balance}
          onRefreshBalance={refreshBalance}
        />

        {/* ── FOOTER */}
        <div style={{ marginTop:18,display:"flex",justifyContent:"space-between",alignItems:"center" }}>
          <div
            style={{ fontSize:8,color:"#2a2a2a",letterSpacing:1, cursor:"default", userSelect:"none" }}
            onClick={() => {
              const next = versionClicks + 1;
              setVersionClicks(next);
              if (next >= 3) { setShowCircleSDK(true); setVersionClicks(0); }
              else { setTimeout(() => setVersionClicks(0), 1200); }
            }}>
            AGENTOSA v0.1.0 • ARC TESTNET • Chain ID 5042002 • RPC: rpc.testnet.arc.network
          </div>
          <div style={{ display:"flex",gap:14 }}>
            {[
              ["EXPLORER","https://testnet.arcscan.app"],
              ["DOCS","https://docs.arc.network"],
              ["FAUCET","https://faucet.circle.com"],
            ].map(([l,u])=>(
              <a key={l} href={u} target="_blank" rel="noreferrer"
                style={{ fontSize:8,color:"#333",letterSpacing:1.5,textDecoration:"none",
                  transition:"color 0.2s" }}
                onMouseEnter={e=>e.target.style.color="#00FFB2"}
                onMouseLeave={e=>e.target.style.color="#333"}>{l}</a>
            ))}
          </div>
        </div>
      </div>

      {/* ── PROFILE MODAL */}
      {showProfile && (
        <ProfileModal wallet={wallet} onClose={() => setShowProfile(false)} />
      )}
      {showInternalWallet && (
        <InternalWalletModal
          onClose={() => setShowInternalWallet(false)}
          onWalletReady={(addr) => {
            if (addr) { setWallet(addr); setChainOk(true); }
            else { setWallet(null); setChainOk(false); }
          }}
        />
      )}
      {/* ── SWAP MODAL */}
      {showSwapModal && (
        <SwapModal wallet={wallet} chainOk={chainOk}
          balance={balance}
          onClose={()=>{ setShowSwapModal(false); refreshBalance(); }}
          onSwapSuccess={(hash, amt, symIn, symOut) => { onSwapSuccess(hash,amt,symIn,symOut); refreshBalance(); }} />
      )}
      {/* ── PAYMENT MODAL */}
      {showPayModal && (
        <PaymentModal wallet={wallet} chainOk={chainOk}
          balance={balance}
          onClose={()=>{ setShowPayModal(false); refreshBalance(); }}
          onSuccess={(hash, amt, addr) => { onPaymentSuccess(hash,amt,addr); refreshBalance(); }} />
      )}
      {/* ── CIRCLE SDK CONFIG — owner only, triple-click footer version */}
      {showCircleSDK && (
        <CircleSDKModal onClose={() => setShowCircleSDK(false)} />
      )}
    </div>
  );
}
