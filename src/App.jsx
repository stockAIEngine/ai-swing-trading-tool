import React, { useMemo, useState } from "react";
import { motion } from "framer-motion";
import { Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Activity, BarChart3, Brain, CandlestickChart, Cloud, Gauge, RefreshCw, ShieldAlert, TrendingUp } from "lucide-react";

const DEFAULT_SYMBOLS = ["NVDA", "MSFT", "AAPL", "META", "AMZN", "TSLA", "AMD", "NFLX"];
const RISK_REWARD = 2;
const DEFAULT_API_KEY = "6H77L7GQDHEUSFVQ";

function hashSymbol(symbol) {
  return symbol.split("").reduce((sum, char) => sum + char.charCodeAt(0), 0);
}

function seededNoise(seed, i, scale = 1) {
  const x = Math.sin(seed * 999 + i * 12.9898) * 43758.5453;
  return (x - Math.floor(x) - 0.5) * scale;
}

function makeDemoCandles(symbol, days = 140) {
  const seed = hashSymbol(symbol);
  const base = 60 + (seed % 220);
  const trend = ((seed % 11) - 4) / 180;
  let close = base;
  return Array.from({ length: days }, (_, i) => {
    const drift = trend + Math.sin(i / 9 + seed) * 0.006 + seededNoise(seed, i, 0.025);
    const open = close * (1 + seededNoise(seed, i + 1000, 0.015));
    close = Math.max(4, close * (1 + drift));
    const high = Math.max(open, close) * (1 + Math.abs(seededNoise(seed, i + 2000, 0.025)));
    const low = Math.min(open, close) * (1 - Math.abs(seededNoise(seed, i + 3000, 0.025)));
    const volume = Math.round(2_000_000 + (seed % 9) * 700_000 + Math.abs(seededNoise(seed, i + 4000, 1)) * 6_000_000);
    return { date: `Demo ${i + 1}`, open, high, low, close, volume };
  });
}

async function fetchAlphaVantageDaily(symbol, apiKey) {
  const url = `https://www.alphavantage.co/query?function=TIME_SERIES_DAILY_ADJUSTED&symbol=${encodeURIComponent(symbol)}&outputsize=compact&apikey=${encodeURIComponent(apiKey)}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${symbol}: network error ${response.status}`);
  const json = await response.json();

  if (json.Note) throw new Error(`${symbol}: Alpha Vantage rate limit reached. Try fewer tickers or wait before refreshing.`);
  if (json.Information) throw new Error(`${symbol}: ${json.Information}`);
  if (json["Error Message"]) throw new Error(`${symbol}: invalid symbol or API request.`);

  const series = json["Time Series (Daily)"];
  if (!series) throw new Error(`${symbol}: no daily price data returned.`);

  return Object.entries(series)
    .map(([date, row]) => ({
      date,
      open: Number(row["1. open"]),
      high: Number(row["2. high"]),
      low: Number(row["3. low"]),
      close: Number(row["4. close"]),
      adjustedClose: Number(row["5. adjusted close"]),
      volume: Number(row["6. volume"])
    }))
    .filter((c) => Number.isFinite(c.open) && Number.isFinite(c.high) && Number.isFinite(c.low) && Number.isFinite(c.close) && Number.isFinite(c.volume))
    .reverse();
}

function ema(values, period) {
  const k = 2 / (period + 1);
  return values.reduce((arr, value, i) => {
    arr.push(i === 0 ? value : value * k + arr[i - 1] * (1 - k));
    return arr;
  }, []);
}

function rsi(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0;
  let losses = 0;
  for (let i = closes.length - period; i < closes.length; i += 1) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses += Math.abs(diff);
  }
  if (losses === 0) return 100;
  const rs = gains / period / (losses / period);
  return 100 - 100 / (1 + rs);
}

function macd(closes) {
  if (closes.length < 35) return { macd: null, signal: null };
  const e12 = ema(closes, 12);
  const e26 = ema(closes, 26);
  const line = closes.map((_, i) => e12[i] - e26[i]);
  const sig = ema(line.slice(26), 9);
  return { macd: line[line.length - 1], signal: sig[sig.length - 1] };
}

function atr(candles, period = 14) {
  if (candles.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < candles.length; i += 1) {
    const c = candles[i];
    const prev = candles[i - 1];
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close)));
  }
  const recent = trs.slice(-period);
  return recent.reduce((s, v) => s + v, 0) / recent.length;
}

function detectHammer(candle) {
  const body = Math.abs(candle.close - candle.open);
  if (!body) return false;
  const lower = Math.min(candle.open, candle.close) - candle.low;
  const upper = candle.high - Math.max(candle.open, candle.close);
  return lower > body * 2 && upper < body;
}

function detectBullishEngulfing(prev, cur) {
  if (!prev || !cur) return false;
  return prev.close < prev.open && cur.close > cur.open && cur.close > prev.open && cur.open < prev.close;
}

function backtest(candles, ema20, ema50) {
  let trades = 0;
  let wins = 0;
  let pnl = 0;
  for (let i = 50; i < candles.length - 5; i += 1) {
    const slice = candles.slice(0, i + 1);
    const closes = slice.map((c) => c.close);
    const rsiNow = rsi(closes);
    const macdNow = macd(closes);
    const atrNow = atr(slice);
    const row = candles[i];
    const bullish = row.close > ema20[i] && ema20[i] > ema50[i] && rsiNow > 50 && macdNow.macd > macdNow.signal;
    if (!bullish || !atrNow) continue;
    trades += 1;
    const entry = row.close;
    const stop = entry - atrNow;
    const target = entry + (entry - stop) * RISK_REWARD;
    let exit = candles[i + 5].close;
    for (const future of candles.slice(i + 1, i + 6)) {
      if (future.high >= target) { exit = target; break; }
      if (future.low <= stop) { exit = stop; break; }
    }
    const tradePnl = exit - entry;
    pnl += tradePnl;
    if (tradePnl > 0) wins += 1;
  }
  return { trades, wins, pnl, winRate: trades ? Math.round((wins / trades) * 100) : 0 };
}

function analyzeSymbol(symbol, candles, source = "Demo") {
  const safeCandles = candles?.length >= 60 ? candles : makeDemoCandles(symbol);
  const closes = safeCandles.map((c) => c.close);
  const volumes = safeCandles.map((c) => c.volume);
  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const latest = safeCandles[safeCandles.length - 1];
  const previous = safeCandles[safeCandles.length - 2];
  const avgVol = volumes.slice(-20).reduce((s, v) => s + v, 0) / 20;
  const rsiNow = rsi(closes);
  const macdNow = macd(closes);
  const atrNow = atr(safeCandles);
  const hammer = detectHammer(latest);
  const engulfing = detectBullishEngulfing(previous, latest);
  const bt = backtest(safeCandles, ema20, ema50);

  let score = 0;
  const checks = [];
  const add = (condition, points, text) => {
    if (condition) {
      score += points;
      checks.push(text);
    }
  };

  add(latest.close > ema20.at(-1) && ema20.at(-1) > ema50.at(-1), 1, "Bullish EMA trend");
  add(rsiNow > 50 && rsiNow < 70, 1, "RSI in 50–70 momentum zone");
  add(macdNow.macd > macdNow.signal, 1, "MACD above signal line");
  add(latest.volume > avgVol, 1, "Volume above 20-day average");
  add(hammer, 1, "Hammer candlestick detected");
  add(engulfing, 1, "Bullish engulfing detected");
  add(bt.winRate >= 55, 1, "Backtest win rate above 55%");
  add(closes.at(-1) > closes.at(-6), 1, "Positive 5-day momentum");

  const aiProbability = Math.min(95, Math.max(8, Math.round(32 + score * 7 + Math.max(0, bt.winRate - 45) * 0.45)));
  if (aiProbability >= 65) score += 2;

  const signal = score >= 8 ? "STRONG BUY" : score >= 5 ? "BUY" : score >= 3 ? "WATCH" : "NO TRADE";
  const entry = latest.close;
  const stopLoss = entry - atrNow * 1.5;
  const target = entry + (entry - stopLoss) * RISK_REWARD;

  return {
    symbol,
    source,
    signal,
    entry,
    stopLoss,
    target,
    aiProbability,
    score,
    lastUpdated: latest.date,
    indicators: { rsi: rsiNow, ema20: ema20.at(-1), ema50: ema50.at(-1), macd: macdNow.macd, macdSignal: macdNow.signal, atr: atrNow, avgVol, hammer, engulfing },
    backtest: bt,
    checks,
    chart: safeCandles.map((c, i) => ({ ...c, close: Number(c.close.toFixed(2)), ema20: Number(ema20[i].toFixed(2)), ema50: Number(ema50[i].toFixed(2)), volumeM: Number((c.volume / 1_000_000).toFixed(2)) })).slice(-60)
  };
}

function money(n) {
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

function signalClass(signal) {
  if (signal === "STRONG BUY") return "bg-emerald-100 text-emerald-800 border-emerald-200";
  if (signal === "BUY") return "bg-green-100 text-green-800 border-green-200";
  if (signal === "WATCH") return "bg-amber-100 text-amber-800 border-amber-200";
  return "bg-slate-100 text-slate-700 border-slate-200";
}

function Stat({ label, value }) {
  return <div className="rounded-2xl border bg-white p-3"><div className="text-xs font-semibold text-slate-500">{label}</div><div className="mt-1 text-lg font-black text-slate-900">{value}</div></div>;
}

export default function VisualAISwingTradingTool() {
  const [symbolsText, setSymbolsText] = useState(DEFAULT_SYMBOLS.join(", "));
  const [selected, setSelected] = useState("NVDA");
  const [apiKey, setApiKey] = useState(DEFAULT_API_KEY);
  const [liveCandles, setLiveCandles] = useState({});
  const [errors, setErrors] = useState([]);
  const [loading, setLoading] = useState(false);

  const symbols = useMemo(() => symbolsText.split(/[ ,\n]+/).map((s) => s.trim().toUpperCase()).filter(Boolean).slice(0, 20), [symbolsText]);
  const rows = useMemo(() => symbols.map((symbol) => analyzeSymbol(symbol, liveCandles[symbol], liveCandles[symbol] ? "Alpha Vantage" : "Demo")).sort((a, b) => b.score - a.score || b.aiProbability - a.aiProbability), [symbols, liveCandles]);
  const top = rows.find((r) => r.symbol === selected) || rows[0];

  async function loadRealData() {
    setErrors([]);
    if (!apiKey.trim()) {
      setErrors(["Enter an Alpha Vantage API key first."]);
      return;
    }
    setLoading(true);
    const next = {};
    const nextErrors = [];
    for (const symbol of symbols) {
      try {
        next[symbol] = await fetchAlphaVantageDaily(symbol, apiKey.trim());
      } catch (error) {
        nextErrors.push(error.message || `${symbol}: unable to fetch data.`);
      }
    }
    setLiveCandles((prev) => ({ ...prev, ...next }));
    setErrors(nextErrors);
    setLoading(false);
  }

  return (
    <main className="min-h-screen bg-slate-50 p-4 text-slate-900 md:p-8">
      <div className="mx-auto max-w-7xl">
        <motion.header initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} className="mb-6 rounded-[2rem] bg-gradient-to-br from-slate-950 via-slate-900 to-blue-950 p-6 text-white shadow-xl">
          <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <div>
              <div className="mb-3 inline-flex items-center gap-2 rounded-full bg-white/10 px-3 py-1 text-sm font-bold text-blue-100"><Brain size={16} /> Advanced AI Swing Trading Engine</div>
              <h1 className="text-3xl font-black tracking-tight md:text-5xl">Live Visual Trading Scanner</h1>
              <p className="mt-3 max-w-3xl text-sm text-slate-300 md:text-base">Real daily OHLCV data, technical indicators, candlestick confirmation, AI-style scoring, risk levels, and backtest ranking in one dashboard.</p>
            </div>
            <div className="grid grid-cols-2 gap-3 text-center">
              <div className="rounded-3xl bg-white/10 p-4"><div className="text-3xl font-black">{rows.length}</div><div className="text-xs text-slate-300">Tickers</div></div>
              <div className="rounded-3xl bg-white/10 p-4"><div className="text-3xl font-black">{rows[0]?.symbol || "—"}</div><div className="text-xs text-slate-300">Top Setup</div></div>
            </div>
          </div>
        </motion.header>

        <section className="mb-6 grid gap-4 lg:grid-cols-[1fr_420px]">
          <div className="rounded-[2rem] border bg-white p-5 shadow-sm">
            <div className="mb-4 flex items-center gap-2 text-xl font-black"><Activity /> Scanner Inputs</div>
            <textarea value={symbolsText} onChange={(e) => setSymbolsText(e.target.value)} className="h-24 w-full resize-none rounded-3xl border border-slate-200 bg-slate-50 p-4 font-semibold outline-none focus:border-blue-400" placeholder="Enter tickers separated by commas" />
            <div className="mt-3 flex flex-wrap gap-2">
              {DEFAULT_SYMBOLS.map((s) => <button key={s} onClick={() => setSelected(s)} className="rounded-full border bg-slate-50 px-4 py-2 text-sm font-bold hover:bg-blue-50">{s}</button>)}
            </div>
          </div>

          <div className="rounded-[2rem] border bg-white p-5 shadow-sm">
            <div className="mb-3 flex items-center gap-2 text-xl font-black"><Cloud /> Real Data Connection</div>
            <input value={apiKey} onChange={(e) => setApiKey(e.target.value)} type="password" className="mb-3 w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-semibold outline-none focus:border-blue-400" placeholder="Alpha Vantage API key" />
            <button onClick={loadRealData} disabled={loading} className="flex w-full items-center justify-center gap-2 rounded-2xl bg-blue-600 px-4 py-3 font-black text-white shadow hover:bg-blue-700 disabled:opacity-60">
              <RefreshCw size={18} className={loading ? "animate-spin" : ""} /> {loading ? "Loading Real Data..." : "Fetch Real Market Data"}
            </button>
            <p className="mt-3 text-xs leading-5 text-slate-500">Uses Alpha Vantage daily adjusted OHLCV data. Free keys may be rate-limited, so use fewer tickers when testing.</p>
          </div>
        </section>

        {errors.length > 0 && <div className="mb-6 rounded-3xl border border-rose-200 bg-rose-50 p-4 text-sm font-semibold text-rose-800">{errors.map((e) => <div key={e}>⚠️ {e}</div>)}</div>}

        <section className="mb-6 grid gap-4 md:grid-cols-4">
          <Stat label="Best AI Probability" value={`${rows[0]?.aiProbability || 0}%`} />
          <Stat label="Best Score" value={`${rows[0]?.score || 0}/10`} />
          <Stat label="Best Signal" value={rows[0]?.signal || "—"} />
          <Stat label="Best Data Source" value={rows[0]?.source || "—"} />
        </section>

        <section className="mb-6 grid gap-5 lg:grid-cols-[390px_1fr]">
          <div className="rounded-[2rem] border bg-white p-5 shadow-sm">
            <div className="mb-4 flex items-center gap-2 text-xl font-black"><Gauge /> Ranked Scanner</div>
            <div className="space-y-3">
              {rows.map((row) => (
                <button key={row.symbol} onClick={() => setSelected(row.symbol)} className={`w-full rounded-3xl border p-4 text-left transition hover:shadow-md ${top?.symbol === row.symbol ? "border-blue-300 bg-blue-50" : "bg-white"}`}>
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-2xl font-black">{row.symbol}</div>
                    <span className={`rounded-full border px-3 py-1 text-xs font-black ${signalClass(row.signal)}`}>{row.signal}</span>
                  </div>
                  <div className="mt-2 grid grid-cols-3 gap-2 text-sm">
                    <div><b>{row.aiProbability}%</b><br /><span className="text-slate-500">AI Prob.</span></div>
                    <div><b>{row.score}/10</b><br /><span className="text-slate-500">Score</span></div>
                    <div><b>{row.source}</b><br /><span className="text-slate-500">Source</span></div>
                  </div>
                </button>
              ))}
            </div>
          </div>

          {top && (
            <div className="rounded-[2rem] border bg-white p-5 shadow-sm">
              <div className="mb-4 flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                <div>
                  <div className="flex items-center gap-2 text-3xl font-black"><CandlestickChart /> {top.symbol}</div>
                  <div className="mt-2 text-slate-500">Data: {top.source} • Last candle: {top.lastUpdated}</div>
                </div>
                <span className={`rounded-full border px-4 py-2 text-sm font-black ${signalClass(top.signal)}`}>{top.signal} • {top.aiProbability}%</span>
              </div>

              <div className="mb-5 grid gap-3 md:grid-cols-3">
                <div className="rounded-3xl bg-blue-50 p-4"><div className="text-sm font-bold text-blue-700">Entry</div><div className="text-2xl font-black">{money(top.entry)}</div></div>
                <div className="rounded-3xl bg-emerald-50 p-4"><div className="text-sm font-bold text-emerald-700">Target</div><div className="text-2xl font-black">{money(top.target)}</div></div>
                <div className="rounded-3xl bg-rose-50 p-4"><div className="text-sm font-bold text-rose-700">Stop Loss</div><div className="text-2xl font-black">{money(top.stopLoss)}</div></div>
              </div>

              <div className="h-80 rounded-3xl border bg-slate-50 p-3">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={top.chart} margin={{ left: 6, right: 16, top: 16, bottom: 6 }}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="date" tick={{ fontSize: 11 }} interval={9} />
                    <YAxis domain={["auto", "auto"]} tick={{ fontSize: 11 }} />
                    <Tooltip formatter={(value) => typeof value === "number" ? value.toFixed(2) : value} />
                    <Line type="monotone" dataKey="close" strokeWidth={3} dot={false} name="Close" />
                    <Line type="monotone" dataKey="ema20" strokeWidth={2} dot={false} name="EMA20" />
                    <Line type="monotone" dataKey="ema50" strokeWidth={2} dot={false} name="EMA50" />
                  </LineChart>
                </ResponsiveContainer>
              </div>

              <div className="mt-5 grid gap-4 lg:grid-cols-2">
                <div className="rounded-3xl border bg-white p-4">
                  <div className="mb-3 flex items-center gap-2 text-lg font-black"><TrendingUp /> Indicator Confirmation</div>
                  <div className="grid grid-cols-2 gap-3 text-sm">
                    <Stat label="RSI" value={top.indicators.rsi.toFixed(1)} />
                    <Stat label="ATR" value={money(top.indicators.atr)} />
                    <Stat label="EMA20" value={money(top.indicators.ema20)} />
                    <Stat label="EMA50" value={money(top.indicators.ema50)} />
                  </div>
                  <ul className="mt-4 space-y-2 text-sm text-slate-600">
                    {top.checks.length ? top.checks.map((c) => <li key={c}>✅ {c}</li>) : <li>No strong confirmations yet.</li>}
                  </ul>
                </div>

                <div className="rounded-3xl border bg-white p-4">
                  <div className="mb-3 flex items-center gap-2 text-lg font-black"><BarChart3 /> Volume + Backtest</div>
                  <div className="h-44">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={top.chart.slice(-24)}>
                        <XAxis dataKey="date" hide />
                        <YAxis hide />
                        <Tooltip formatter={(value) => `${value}M`} />
                        <Bar dataKey="volumeM" radius={[8, 8, 0, 0]} name="Volume" />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                  <div className="mt-4 grid grid-cols-3 gap-3">
                    <Stat label="Trades" value={top.backtest.trades} />
                    <Stat label="Wins" value={top.backtest.wins} />
                    <Stat label="Win Rate" value={`${top.backtest.winRate}%`} />
                  </div>
                </div>
              </div>
            </div>
          )}
        </section>

        <div className="rounded-[2rem] border border-amber-200 bg-amber-50 p-5 text-sm leading-6 text-amber-900">
          <div className="mb-1 flex items-center gap-2 font-black"><ShieldAlert size={18} /> Important</div>
          This is an educational scanner, not financial advice. Real market APIs may return delayed, end-of-day, or rate-limited data depending on your plan. Always verify prices with your broker before making any trade.
        </div>
      </div>
    </main>
  );
}
