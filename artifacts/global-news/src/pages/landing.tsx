import { motion, useInView } from "framer-motion";
import { useRef, useEffect, useState } from "react";
import { Link } from "wouter";
import { ArrowRight, Database, MemoryStick, Network, TrendingUp, LogIn } from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { AuthModal } from "@/components/auth/auth-modal";

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

function ScrollReveal({ children, delay = 0, className = "" }: { children: React.ReactNode; delay?: number; className?: string }) {
  const ref = useRef(null);
  const isInView = useInView(ref, { once: true, margin: "-80px" });
  return (
    <motion.div ref={ref} className={className} initial={{ opacity: 0, y: 40 }}
      animate={isInView ? { opacity: 1, y: 0 } : { opacity: 0, y: 40 }}
      transition={{ duration: 0.7, ease: [0.25, 0.1, 0.25, 1], delay }}>
      {children}
    </motion.div>
  );
}

/* Hero Globe */
function HeroGlobe() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let W = canvas.offsetWidth || 680;
    let H = Math.round(W * 0.6);
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    canvas.style.height = H + "px";
    ctx.scale(dpr, dpr);

    const cx = W / 2, cy = H / 2, R = Math.min(W, H) * 0.38;

    const NODES = [
      { lat: 40.7, lon: -74, label: "New York", type: "hub" },
      { lat: 51.5, lon: -0.1, label: "London", type: "hub" },
      { lat: 35.7, lon: 139.7, label: "Tokyo", type: "hub" },
      { lat: 37.6, lon: -122.4, label: "San Francisco", type: "hub" },
      { lat: 55.8, lon: 37.6, label: "Moscow", type: "source" },
      { lat: 31.2, lon: 121.5, label: "Shanghai", type: "source" },
      { lat: 19.1, lon: 72.9, label: "Mumbai", type: "source" },
      { lat: 39.9, lon: 116.4, label: "Beijing", type: "source" },
      { lat: 1.3, lon: 103.8, label: "Singapore", type: "node" },
      { lat: 25.2, lon: 55.3, label: "Dubai", type: "node" },
      { lat: 48.9, lon: 2.3, label: "Paris", type: "node" },
      { lat: -33.9, lon: 18.4, label: "Cape Town", type: "node" },
      { lat: -23.5, lon: -46.6, label: "São Paulo", type: "node" },
      { lat: 59.9, lon: 10.7, label: "Oslo", type: "node" },
      { lat: 22.3, lon: 114.2, label: "Hong Kong", type: "node" },
      { lat: 28.6, lon: 77.2, label: "Delhi", type: "node" },
    ];

    let rotY = 0.4, rotX = 0.18;
    let dragging = false, lastX = 0, lastY = 0;

    const onMouseDown = (e: MouseEvent) => { dragging = true; lastX = e.clientX; lastY = e.clientY; canvas.style.cursor = "grabbing"; };
    const onMouseUp = () => { dragging = false; canvas.style.cursor = "grab"; };
    const onMouseMove = (e: MouseEvent) => {
      if (dragging) { rotY += (e.clientX - lastX) * 0.005; rotX += (e.clientY - lastY) * 0.003; rotX = Math.max(-0.5, Math.min(0.5, rotX)); lastX = e.clientX; lastY = e.clientY; }
    };
    const onTouchStart = (e: TouchEvent) => { dragging = true; lastX = e.touches[0].clientX; lastY = e.touches[0].clientY; };
    const onTouchEnd = () => { dragging = false; };
    const onTouchMove = (e: TouchEvent) => {
      if (dragging) { rotY += (e.touches[0].clientX - lastX) * 0.005; rotX += (e.touches[0].clientY - lastY) * 0.003; rotX = Math.max(-0.5, Math.min(0.5, rotX)); lastX = e.touches[0].clientX; lastY = e.touches[0].clientY; }
    };

    canvas.addEventListener("mousedown", onMouseDown);
    window.addEventListener("mouseup", onMouseUp);
    window.addEventListener("mousemove", onMouseMove);
    canvas.addEventListener("touchstart", onTouchStart, { passive: true });
    window.addEventListener("touchend", onTouchEnd);
    window.addEventListener("touchmove", onTouchMove, { passive: true });

    function project(lat: number, lon: number) {
      const phi = (90 - lat) * Math.PI / 180, theta = (lon + 180) * Math.PI / 180;
      let x = -Math.sin(phi) * Math.cos(theta), y = Math.cos(phi), z = Math.sin(phi) * Math.sin(theta);
      const cosY = Math.cos(rotY), sinY = Math.sin(rotY);
      const x1 = x * cosY + z * sinY, z1 = -x * sinY + z * cosY;
      const cosX = Math.cos(rotX), sinX = Math.sin(rotX);
      const y2 = y * cosX - z1 * sinX, z2 = y * sinX + z1 * cosX;
      return { sx: cx + R * x1, sy: cy - R * y2, z: z2 };
    }

    function arcPoints(la1: number, lo1: number, la2: number, lo2: number, lift = 1.35, steps = 60) {
      const pts = [];
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const phi1 = (90 - la1) * Math.PI / 180, th1 = (lo1 + 180) * Math.PI / 180;
        const phi2 = (90 - la2) * Math.PI / 180, th2 = (lo2 + 180) * Math.PI / 180;
        const ax = -Math.sin(phi1) * Math.cos(th1), ay = Math.cos(phi1), az = Math.sin(phi1) * Math.sin(th1);
        const bx = -Math.sin(phi2) * Math.cos(th2), by = Math.cos(phi2), bz = Math.sin(phi2) * Math.sin(th2);
        const dot = Math.max(-1, Math.min(1, ax * bx + ay * by + az * bz));
        const omega = Math.acos(dot);
        let rx: number, ry: number, rz: number;
        if (omega < 0.001) { rx = ax; ry = ay; rz = az; }
        else {
          const s = Math.sin(omega);
          const wa = Math.sin((1 - t) * omega) / s, wb = Math.sin(t * omega) / s;
          rx = wa * ax + wb * bx; ry = wa * ay + wb * by; rz = wa * az + wb * bz;
        }
        const arcLift = 1 + (lift - 1) * Math.sin(t * Math.PI) * 0.8 + 0.25 * Math.sin(t * Math.PI);
        const nx = rx * arcLift, ny = ry * arcLift, nz = rz * arcLift;
        const cosY = Math.cos(rotY), sinY = Math.sin(rotY);
        const x1 = nx * cosY + nz * sinY, z1 = -nx * sinY + nz * cosY;
        const cosX = Math.cos(rotX), sinX = Math.sin(rotX);
        const y2 = ny * cosX - z1 * sinX, z2 = ny * sinX + z1 * cosX;
        pts.push({ sx: cx + R * x1, sy: cy - R * y2, z: z2 });
      }
      return pts;
    }

    const CONNECTIONS = [
      [0, 1], [0, 2], [0, 3], [1, 4], [1, 10], [2, 7], [2, 8], [3, 0], [3, 12],
      [4, 1], [5, 2], [6, 9], [7, 14], [8, 9], [10, 13], [11, 12], [14, 8], [15, 6],
      [0, 10], [2, 14], [1, 8], [3, 6], [7, 5], [4, 0]
    ];

    const pulses: { i: number; j: number; t: number; speed: number }[] = [];
    const pulseInterval = setInterval(() => {
      const ci = Math.floor(Math.random() * CONNECTIONS.length);
      const [i, j] = CONNECTIONS[ci];
      pulses.push({ i, j, t: Math.random() * 0.3, speed: 0.007 + Math.random() * 0.006 });
    }, 600);

    let rafId = 0;

    function draw() {
      ctx!.clearRect(0, 0, W, H);

      // Globe base
      const grad = ctx!.createRadialGradient(cx - R * 0.2, cy - R * 0.2, R * 0.05, cx, cy, R);
      grad.addColorStop(0, "#0e1e40"); grad.addColorStop(0.6, "#060e22"); grad.addColorStop(1, "#020508");
      ctx!.beginPath(); ctx!.arc(cx, cy, R, 0, Math.PI * 2);
      ctx!.fillStyle = grad; ctx!.fill();

      // Atmosphere glow
      const atmG = ctx!.createRadialGradient(cx, cy, R * 0.92, cx, cy, R * 1.12);
      atmG.addColorStop(0, "rgba(30,90,255,0)");
      atmG.addColorStop(0.6, "rgba(30,90,255,0.07)");
      atmG.addColorStop(1, "rgba(60,140,255,0.22)");
      ctx!.beginPath(); ctx!.arc(cx, cy, R * 1.12, 0, Math.PI * 2);
      ctx!.fillStyle = atmG; ctx!.fill();

      // Grid lines
      for (let lat = -60; lat <= 60; lat += 30) {
        ctx!.beginPath(); let first = true;
        for (let lo = -180; lo <= 181; lo += 3) {
          const p = project(lat, lo);
          if (p.z > -0.02) { first ? ctx!.moveTo(p.sx, p.sy) : ctx!.lineTo(p.sx, p.sy); first = false; } else first = true;
        }
        ctx!.strokeStyle = "rgba(255,255,255,0.13)"; ctx!.lineWidth = 0.5; ctx!.stroke();
      }
      for (let lon = -150; lon <= 180; lon += 30) {
        ctx!.beginPath(); let first = true;
        for (let la = -85; la <= 85; la += 3) {
          const p = project(la, lon);
          if (p.z > -0.02) { first ? ctx!.moveTo(p.sx, p.sy) : ctx!.lineTo(p.sx, p.sy); first = false; } else first = true;
        }
        ctx!.strokeStyle = "rgba(255,255,255,0.13)"; ctx!.lineWidth = 0.5; ctx!.stroke();
      }

      // Arcs
      CONNECTIONS.forEach(([i, j]) => {
        const a = NODES[i], b = NODES[j];
        const pa = project(a.lat, a.lon), pb = project(b.lat, b.lon);
        if (pa.z < -0.1 && pb.z < -0.1) return;
        const pts = arcPoints(a.lat, a.lon, b.lat, b.lon, 1.4, 50);
        ctx!.beginPath(); let started = false;
        pts.forEach((p) => {
          if (p.z > -0.05) { if (!started) { ctx!.moveTo(p.sx, p.sy); started = true; } else ctx!.lineTo(p.sx, p.sy); } else { started = false; }
        });
        const ta = NODES[i].type, tb = NODES[j].type;
        let col = "rgba(40,120,255,0.25)";
        if (ta === "hub" || tb === "hub") col = "rgba(50,150,255,0.3)";
        if (ta === "source" || tb === "source") col = "rgba(200,60,60,0.22)";
        ctx!.strokeStyle = col; ctx!.lineWidth = 1; ctx!.stroke();
      });

      // Pulse dots
      pulses.forEach((p) => {
        const a = NODES[p.i], b = NODES[p.j];
        const pts = arcPoints(a.lat, a.lon, b.lat, b.lon, 1.4, 50);
        const idx = Math.floor(p.t * 50);
        if (idx < 0 || idx >= pts.length) return;
        const pt = pts[idx];
        if (pt.z < 0) return;
        const alpha = (p.t < 0.15 ? p.t / 0.15 : p.t > 0.85 ? (1 - p.t) / 0.15 : 1);
        const ta = NODES[p.i].type;
        let r = 2.5, col2 = "";
        if (ta === "hub") { col2 = `rgba(80,180,255,${alpha})`; r = 3.5; }
        else if (ta === "source") { col2 = `rgba(255,90,90,${alpha})`; r = 2.8; }
        else { col2 = `rgba(100,255,180,${alpha})`; r = 2.5; }
        for (let t = 1; t <= 8; t++) {
          const ti = idx - t; if (ti < 0) continue;
          const tp = pts[ti]; if (tp.z < 0) continue;
          const a2 = alpha * (1 - t / 9) * 0.5;
          ctx!.beginPath(); ctx!.arc(tp.sx, tp.sy, r * 0.5, 0, Math.PI * 2);
          ctx!.fillStyle = col2.replace(`${alpha})`, `${a2})`); ctx!.fill();
        }
        ctx!.beginPath(); ctx!.arc(pt.sx, pt.sy, r, 0, Math.PI * 2);
        ctx!.fillStyle = col2; ctx!.fill();
        ctx!.beginPath(); ctx!.arc(pt.sx, pt.sy, r * 2.5, 0, Math.PI * 2);
        ctx!.fillStyle = col2.replace(`${alpha})`, `${alpha * 0.25})`); ctx!.fill();
      });

      // Nodes
      const positions = NODES.map((n) => ({ ...project(n.lat, n.lon), label: n.label, type: n.type }));
      positions.forEach((p, i) => {
        if (p.z < -0.05) return;
        const vis = Math.max(0, (p.z + 0.05) / 1.05);
        const n = NODES[i];
        let col = "", r = 3, glow = "";
        if (n.type === "hub") { col = "rgba(60,170,255,1)"; r = 5.5; glow = "rgba(60,170,255,0.35)"; }
        else if (n.type === "source") { col = "rgba(255,80,80,0.95)"; r = 4; glow = "rgba(255,80,80,0.3)"; }
        else { col = "rgba(80,230,160,0.9)"; r = 3; glow = "rgba(80,230,160,0.25)"; }
        ctx!.beginPath(); ctx!.arc(p.sx, p.sy, r * 3.5 * vis, 0, Math.PI * 2);
        ctx!.fillStyle = glow.replace("0.35", "0.12").replace("0.3", "0.1").replace("0.25", "0.1"); ctx!.fill();
        ctx!.beginPath(); ctx!.arc(p.sx, p.sy, r * 2 * vis, 0, Math.PI * 2);
        ctx!.fillStyle = glow; ctx!.fill();
        ctx!.beginPath(); ctx!.arc(p.sx, p.sy, r * vis, 0, Math.PI * 2);
        ctx!.fillStyle = col; ctx!.fill();
        if (vis > 0.45) {
          const fsz = Math.round(9 + 3 * vis);
          ctx!.font = `${fsz}px system-ui,sans-serif`;
          ctx!.textAlign = "center";
          ctx!.fillStyle = `rgba(190,220,255,${Math.min(1, (vis - 0.45) * 3)})`;
          ctx!.fillText(n.label, p.sx, p.sy - r * vis - 5);
        }
      });

      // Legend
      const leg = [{ col: "rgba(60,170,255,1)", label: "Intelligence Hub" }, { col: "rgba(255,80,80,0.95)", label: "Data Source" }, { col: "rgba(80,230,160,0.9)", label: "Analysis Node" }];
      leg.forEach((l, i) => {
        const lx = 16, ly = H - 18 - i * 18;
        ctx!.beginPath(); ctx!.arc(lx, ly, 4, 0, Math.PI * 2); ctx!.fillStyle = l.col; ctx!.fill();
        ctx!.font = "11px system-ui,sans-serif"; ctx!.textAlign = "left";
        ctx!.fillStyle = "rgba(160,190,230,0.7)"; ctx!.fillText(l.label, lx + 10, ly + 4);
      });
    }

    function animate() {
      if (!dragging) rotY += 0.0018;
      pulses.forEach((p) => { p.t += p.speed; });
      for (let i = pulses.length - 1; i >= 0; i--) if (pulses[i].t >= 1) pulses.splice(i, 1);
      draw();
      rafId = requestAnimationFrame(animate);
    }
    animate();

    return () => {
      cancelAnimationFrame(rafId);
      clearInterval(pulseInterval);
      canvas.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("mouseup", onMouseUp);
      window.removeEventListener("mousemove", onMouseMove);
      canvas.removeEventListener("touchstart", onTouchStart as any);
      window.removeEventListener("touchend", onTouchEnd);
      window.removeEventListener("touchmove", onTouchMove as any);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      style={{ display: "block", width: "100%", maxWidth: "720px", cursor: "grab", borderRadius: "12px" }}
    />
  );
}

/* Feature 1: Ingestion Ops Card */
function IngestionOpsCard() {
  const [total, setTotal] = useState(499800);
  const sources = [
    { name: "Open-source news", count: "184,200", pct: 92, type: "active", dot: "bg-[#1e50d4] shadow-[0_0_6px_rgba(30,80,212,0.8)]" },
    { name: "Social sentiment", count: "112,400", pct: 78, type: "live", dot: "bg-[#1e50d4] shadow-[0_0_6px_rgba(30,80,212,0.8)]" },
    { name: "Satellite imagery", count: "38,100", pct: 55, type: "live", dot: "bg-[#d4701e] shadow-[0_0_6px_rgba(212,112,30,0.7)]" },
    { name: "Shipping manifests", count: "61,800", pct: 67, type: "active", dot: "bg-[#1e50d4] shadow-[0_0_6px_rgba(30,80,212,0.8)]" },
    { name: "Financial signals", count: "29,300", pct: 48, type: "live", dot: "bg-[#1e50d4] shadow-[0_0_6px_rgba(30,80,212,0.8)]" },
    { name: "Dark web monitoring", count: "14,700", pct: 32, type: "active", dot: "bg-[#c0392b] shadow-[0_0_6px_rgba(192,57,43,0.8)]" },
    { name: "Gov & diplomatic", count: "22,900", pct: 41, type: "live", dot: "bg-[#d4701e] shadow-[0_0_6px_rgba(212,112,30,0.7)]" },
    { name: "SIGINT intercepts", count: "9,100", pct: 24, type: "active", dot: "bg-[#c0392b] shadow-[0_0_6px_rgba(192,57,43,0.8)]" },
  ];

  useEffect(() => {
    const t = setTimeout(() => {
      document.querySelectorAll<HTMLElement>(".src-bar-fill").forEach((b) => { b.style.width = b.dataset.pct + "%"; });
    }, 300);
    const iv = setInterval(() => setTotal((n: number) => n + Math.floor(Math.random() * 12 - 4)), 3000);
    return () => { clearTimeout(t); clearInterval(iv); };
  }, []);

  return (
    <div className="bg-[#05070d] rounded-[14px] overflow-hidden font-sans w-full">
      <div className="grid grid-cols-1 md:grid-cols-2 min-h-[400px]">
        <div className="p-10 md:p-11 flex flex-col justify-center" style={{ borderRight: "0.5px solid rgba(255,255,255,0.04)" }}>
          <div className="text-[9px] tracking-[0.22em] text-[#1e50d4] font-semibold uppercase mb-[18px]">01 / Data Sources</div>
          <div className="text-[28px] md:text-[32px] font-bold text-[#dde6f5] leading-[1.1] mb-[18px] tracking-[-0.02em]">Intelligent<br />Ingestion</div>
          <div className="text-[12px] md:text-[12.5px] text-[#3d5270] leading-[1.8]">Automated monitoring of 500,000+ sources including local news, social sentiment, satellite imagery, and shipping manifests. Neural filters eliminate noise before it reaches your desk.</div>
        </div>
        <div className="p-7 md:p-9 flex flex-col justify-center">
          <div>
            {sources.map((s) => (
              <div key={s.name} className="flex items-center py-[11px]" style={{ borderBottom: "0.5px solid rgba(255,255,255,0.03)" }}>
                <div className={`w-[5px] h-[5px] rounded-full mr-[14px] flex-shrink-0 ${s.dot}`} />
                <div className="text-[11px] text-[#5a7090] tracking-[0.04em] flex-1">{s.name}</div>
                <div className="text-[10px] text-[#1e3060] mr-4 tabular-nums">{s.count}</div>
                <div className="w-[60px] h-[1px] bg-white/5 relative">
                  <div className="src-bar-fill absolute top-0 left-0 h-[1px] bg-[#1e50d4] transition-[width] duration-[2000ms] ease-out" style={{ width: "0%" }} data-pct={String(s.pct)} />
                </div>
                <div className={`text-[8.5px] tracking-[0.1em] uppercase ml-[14px] min-w-[40px] text-right ${s.type === "live" ? "text-[#1e6040]" : "text-[#1e3060]"}`}>{s.type}</div>
              </div>
            ))}
          </div>
          <div className="mt-5 pt-4" style={{ borderTop: "0.5px solid rgba(255,255,255,0.06)" }}>
            <div className="text-[26px] font-bold text-[#dde6f5] tracking-[-0.02em] tabular-nums">{total.toLocaleString()}+</div>
            <div className="text-[9px] tracking-[0.14em] text-[#1e3060] uppercase mt-[3px]">Active sources monitored</div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* Feature 2: Extraction Ops Card */
function ExtractionOpsCard() {
  const [sps, setSps] = useState(1100);
  const [entries, setEntries] = useState<{ ts: string; raw: string; tags: { t: string; c: string }[]; causal: string; effect: string }[]>([]);
  const idxRef = useRef(0);

  const EVENTS = [
    { ts: "14:32:07 UTC", raw: "Central bank raises rates 50bps — bond markets react sharply", tags: [{ t: "Central Bank", c: "bg-[rgba(30,80,212,0.1)] text-[#2a60d4] border-[0.5px] border-[rgba(30,80,212,0.2)]" }, { t: "50bps", c: "bg-[rgba(30,80,212,0.1)] text-[#2a60d4] border-[0.5px] border-[rgba(30,80,212,0.2)]" }, { t: "Bearish", c: "bg-[rgba(160,40,40,0.1)] text-[#a02828] border-[0.5px] border-[rgba(160,40,40,0.2)]" }], causal: "Rate hike", effect: "→ bond selloff, EM capital flight +34%" },
    { ts: "14:31:54 UTC", raw: "3 dark vessels detected near contested strait, MMSI masked", tags: [{ t: "Maritime", c: "bg-[rgba(30,80,212,0.1)] text-[#2a60d4] border-[0.5px] border-[rgba(30,80,212,0.2)]" }, { t: "SIGINT", c: "bg-[rgba(30,80,212,0.1)] text-[#2a60d4] border-[0.5px] border-[rgba(30,80,212,0.2)]" }, { t: "Alert", c: "bg-[rgba(160,100,20,0.1)] text-[#a06414] border-[0.5px] border-[rgba(160,100,20,0.2)]" }], causal: "Vessel movement", effect: "→ escalation probability +18%" },
    { ts: "14:31:41 UTC", raw: "Tech sector beats estimates 23% — rotation into AI accelerates", tags: [{ t: "Tech", c: "bg-[rgba(30,80,212,0.1)] text-[#2a60d4] border-[0.5px] border-[rgba(30,80,212,0.2)]" }, { t: "AI/ML", c: "bg-[rgba(30,80,212,0.1)] text-[#2a60d4] border-[0.5px] border-[rgba(30,80,212,0.2)]" }, { t: "Bullish", c: "bg-[rgba(20,100,60,0.1)] text-[#1a6040] border-[0.5px] border-[rgba(20,100,60,0.2)]" }], causal: "Earnings beat", effect: "→ growth rotation, vol compression" },
    { ts: "14:31:28 UTC", raw: "Asian port congestion >72hrs across 3 major logistics hubs", tags: [{ t: "Supply Chain", c: "bg-[rgba(30,80,212,0.1)] text-[#2a60d4] border-[0.5px] border-[rgba(30,80,212,0.2)]" }, { t: "Asia Pacific", c: "bg-[rgba(30,80,212,0.1)] text-[#2a60d4] border-[0.5px] border-[rgba(30,80,212,0.2)]" }, { t: "Bearish", c: "bg-[rgba(160,40,40,0.1)] text-[#a02828] border-[0.5px] border-[rgba(160,40,40,0.2)]" }], causal: "Port disruption", effect: "→ commodity lag, CPI uptick Q2" },
    { ts: "14:31:15 UTC", raw: "Unusual comms burst near border — 14 actors identified, HUMINT corroborated", tags: [{ t: "HUMINT", c: "bg-[rgba(30,80,212,0.1)] text-[#2a60d4] border-[0.5px] border-[rgba(30,80,212,0.2)]" }, { t: "14 Actors", c: "bg-[rgba(30,80,212,0.1)] text-[#2a60d4] border-[0.5px] border-[rgba(30,80,212,0.2)]" }, { t: "Critical", c: "bg-[rgba(160,40,40,0.1)] text-[#a02828] border-[0.5px] border-[rgba(160,40,40,0.2)]" }], causal: "Comms pattern", effect: "→ mobilisation signal, conflict risk elevated" },
  ];

  useEffect(() => {
    const addEntry = () => {
      const ev = EVENTS[idxRef.current % EVENTS.length];
      idxRef.current++;
      setEntries((prev) => {
        const next = [{ ...ev, key: idxRef.current }, ...prev];
        return next.slice(0, 3);
      });
    };
    addEntry();
    const iv = setInterval(addEntry, 3200);
    const iv2 = setInterval(() => setSps(Math.round(1100 + Math.random() * 500)), 900);
    return () => { clearInterval(iv); clearInterval(iv2); };
  }, []);

  return (
    <div className="bg-[#05070d] rounded-[14px] overflow-hidden font-sans w-full">
      <div className="grid grid-cols-1 md:grid-cols-2 min-h-[420px]">
        <div className="p-7 md:p-9 flex flex-col justify-center overflow-hidden">
          <div className="flex items-center gap-2 mb-4">
            <div className="w-[5px] h-[5px] rounded-full bg-[#1e6040] shadow-[0_0_5px_rgba(30,96,64,0.9)] animate-pulse" />
            <div className="text-[9px] tracking-[0.18em] text-[#1e3060] uppercase">Live extraction feed</div>
          </div>
          <div className="space-y-0">
            {entries.map((ev, i) => (
              <div key={(ev as any).key || i} className="py-[13px]" style={{ borderBottom: "0.5px solid rgba(255,255,255,0.03)" }}>
                <div className="text-[8px] text-[#1a2540] tracking-[0.08em] uppercase mb-1">{ev.ts}</div>
                <div className="text-[10px] text-[#3a4e68] font-mono leading-[1.5] mb-[7px]">{ev.raw}</div>
                <div className="flex flex-wrap gap-1 mb-[5px]">
                  {ev.tags.map((t) => (
                    <span key={t.t} className={`text-[8.5px] tracking-[0.06em] px-[7px] py-[2px] rounded-[2px] font-semibold uppercase ${t.c}`}>{t.t}</span>
                  ))}
                </div>
                <div className="text-[9px] text-[#1e3355] tracking-[0.02em]">{ev.causal} <span className="text-[#1e50d4]">{ev.effect}</span></div>
              </div>
            ))}
          </div>
        </div>
        <div className="p-10 md:p-11 flex flex-col justify-center" style={{ borderLeft: "0.5px solid rgba(255,255,255,0.04)" }}>
          <div className="text-[9px] tracking-[0.22em] text-[#1e50d4] font-semibold uppercase mb-[18px]">02 / Processing</div>
          <div className="text-[28px] md:text-[32px] font-bold text-[#dde6f5] leading-[1.1] mb-[18px] tracking-[-0.02em]">Structured<br />Extraction</div>
          <div className="text-[12px] md:text-[12.5px] text-[#3d5270] leading-[1.8]">Transforming chaotic world events into high-fidelity data points. Entities, sentiments, and causal relationships identified with 99.8% precision across 40 languages.</div>
          <div className="mt-7 grid grid-cols-2 gap-3">
            {[{ n: sps.toLocaleString(), l: "Signals / sec" }, { n: "99.8%", l: "Precision" }, { n: "40", l: "Languages" }, { n: "<80ms", l: "Latency" }].map((s) => (
              <div key={s.l} className="pt-3" style={{ borderTop: "1px solid rgba(30,80,212,0.3)" }}>
                <div className="text-[22px] font-bold text-[#dde6f5] tracking-[-0.02em]">{s.n}</div>
                <div className="text-[9px] tracking-[0.12em] text-[#1e3060] uppercase mt-[3px]">{s.l}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/* Feature 3: Knowledge Graph Ops Card */
function KnowledgeGraphOpsCard() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [effects, setEffects] = useState<{ cause: string; effect: string }[]>([]);
  const efIdxRef = useRef(0);

  const EFFECTS = [
    { cause: "Fed rate hike", effect: "USD strength → EM debt stress → contagion" },
    { cause: "Port congestion", effect: "Shipping lag → commodity spike → CPI drift" },
    { cause: "Dark vessel activity", effect: "Strait closure risk → oil +$4.20 → inflation" },
    { cause: "SIGINT burst", effect: "Mobilisation signal → border risk elevated" },
    { cause: "Equity rotation", effect: "Growth bid → yield curve steepening" },
  ];

  useEffect(() => {
    const addEffect = () => {
      const ef = EFFECTS[efIdxRef.current % EFFECTS.length];
      efIdxRef.current++;
      setEffects((prev) => {
        const next = [{ ...ef, key: efIdxRef.current }, ...prev];
        return next.slice(0, 4);
      });
    };
    addEffect();
    const iv = setInterval(addEffect, 3500);
    return () => clearInterval(iv);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const gx = canvas.getContext("2d");
    if (!gx) return;

    let GW = 0, GH = 0;
    const rz = () => {
      const parent = canvas.parentElement;
      if (!parent) return;
      const rect = parent.getBoundingClientRect();
      GW = rect.width; GH = rect.height;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(GW * dpr); canvas.height = Math.round(GH * dpr);
      gx.scale(dpr, dpr);
    };
    rz();

    const NODES = [
      { id: 0, lbl: "Fed Policy", x: 0.5, y: 0.13, col: "#c0392b", sz: 5 },
      { id: 1, lbl: "USD Index", x: 0.76, y: 0.27, col: "#1e50d4", sz: 4.5 },
      { id: 2, lbl: "Bond Yield", x: 0.38, y: 0.32, col: "#1e50d4", sz: 4.5 },
      { id: 3, lbl: "Oil Price", x: 0.72, y: 0.52, col: "#b07820", sz: 4 },
      { id: 4, lbl: "Shipping", x: 0.24, y: 0.58, col: "#1a6040", sz: 4 },
      { id: 5, lbl: "EM Debt", x: 0.82, y: 0.7, col: "#1e50d4", sz: 3.5 },
      { id: 6, lbl: "Inflation", x: 0.16, y: 0.36, col: "#8b2090", sz: 3.5 },
      { id: 7, lbl: "Supply Chain", x: 0.58, y: 0.76, col: "#1a6040", sz: 3.5 },
      { id: 8, lbl: "Geo Risk", x: 0.3, y: 0.18, col: "#b07820", sz: 3.5 },
      { id: 9, lbl: "Equities", x: 0.54, y: 0.44, col: "#1e50d4", sz: 3 },
    ];
    const EDGES = [[0, 1], [0, 2], [0, 6], [1, 3], [1, 5], [2, 9], [3, 7], [4, 7], [4, 6], [5, 3], [6, 2], [8, 0], [9, 1], [7, 5], [8, 6]];
    const ripples: { from: number; to: number; t: number; speed: number; col: string }[] = [];
    let T = 0, rTimer = 0, rafId = 0;

    const hexToRgb = (h: string) => {
      const r = parseInt(h.slice(1, 3), 16), g = parseInt(h.slice(3, 5), 16), b = parseInt(h.slice(5, 7), 16);
      return `${r},${g},${b}`;
    };
    const qPt = (ax: number, ay: number, bx: number, by: number, t: number) => {
      const mx = (ax + bx) / 2 - (by - ay) * 0.3, my = (ay + by) / 2 + (bx - ax) * 0.3;
      return { x: (1 - t) ** 2 * ax + 2 * (1 - t) * t * mx + t ** 2 * bx, y: (1 - t) ** 2 * ay + 2 * (1 - t) * t * my + t ** 2 * by };
    };
    const fireRipple = (from: number) => {
      EDGES.filter((e) => e[0] === from || e[1] === from).forEach((e) => {
        const to = e[0] === from ? e[1] : e[0];
        ripples.push({ from, to, t: 0, speed: 0.007, col: NODES[from].col });
      });
    };

    const draw = () => {
      T++;
      const w = GW, h = GH;
      gx.clearRect(0, 0, w, h);
      EDGES.forEach(([a, b]) => {
        const na = NODES[a], nb = NODES[b];
        const ax = na.x * w, ay = na.y * h, bx = nb.x * w, by = nb.y * h;
        const mx = (ax + bx) / 2 - (by - ay) * 0.3, my = (ay + by) / 2 + (bx - ax) * 0.3;
        gx.beginPath(); gx.moveTo(ax, ay); gx.quadraticCurveTo(mx, my, bx, by);
        gx.strokeStyle = "rgba(20,35,70,0.9)"; gx.lineWidth = 0.8; gx.stroke();
      });
      ripples.forEach((rip) => {
        const na = NODES[rip.from], nb = NODES[rip.to];
        const ax = na.x * w, ay = na.y * h, bx = nb.x * w, by = nb.y * h;
        const p = qPt(ax, ay, bx, by, rip.t);
        const a = Math.min(1, rip.t * 8) * Math.min(1, (1 - rip.t) * 6);
        const rgb = hexToRgb(rip.col);
        for (let i = 6; i >= 0; i--) {
          const tp = Math.max(0, rip.t - i * 0.016);
          const pp = qPt(ax, ay, bx, by, tp);
          gx.beginPath(); gx.arc(pp.x, pp.y, 2.5 * (1 - i / 7), 0, Math.PI * 2);
          gx.fillStyle = `rgba(${rgb},${a * (1 - i / 7) * 0.5})`; gx.fill();
        }
        gx.beginPath(); gx.arc(p.x, p.y, 3, 0, Math.PI * 2);
        gx.fillStyle = `rgba(${rgb},${a})`; gx.fill();
      });
      NODES.forEach((n) => {
        const nx = n.x * w, ny = n.y * h;
        const rgb = hexToRgb(n.col);
        const breathe = 1 + 0.08 * Math.sin(T * 0.035 + n.id * 0.9);
        gx.beginPath(); gx.arc(nx, ny, n.sz * 3 * breathe, 0, Math.PI * 2);
        gx.fillStyle = `rgba(${rgb},0.05)`; gx.fill();
        gx.beginPath(); gx.arc(nx, ny, n.sz * breathe, 0, Math.PI * 2);
        gx.fillStyle = n.col; gx.fill();
        gx.font = "500 9px system-ui,sans-serif";
        gx.fillStyle = "rgba(140,170,210,0.6)";
        gx.textAlign = "center";
        gx.fillText(n.lbl, nx, ny - n.sz - 6);
      });
      rTimer++;
      if (rTimer % 100 === 0) fireRipple(Math.floor(Math.random() * NODES.length));
      for (let i = ripples.length - 1; i >= 0; i--) { ripples[i].t += ripples[i].speed; if (ripples[i].t >= 1) ripples.splice(i, 1); }
      rafId = requestAnimationFrame(draw);
    };
    rafId = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(rafId);
  }, []);

  return (
    <div className="bg-[#05070d] rounded-[14px] overflow-hidden font-sans w-full">
      <div className="grid grid-cols-1 md:grid-cols-2 min-h-[440px]">
        <div className="p-10 md:p-11 flex flex-col justify-center" style={{ borderRight: "0.5px solid rgba(255,255,255,0.04)" }}>
          <div className="text-[9px] tracking-[0.22em] text-[#1e50d4] font-semibold uppercase mb-[18px]">03 / Synthesis</div>
          <div className="text-[28px] md:text-[32px] font-bold text-[#dde6f5] leading-[1.1] mb-[18px] tracking-[-0.02em]">Living Knowledge<br />Graph</div>
          <div className="text-[12px] md:text-[12.5px] text-[#3d5270] leading-[1.8] mb-6">A dynamic, interconnected map of global power dynamics. Every event ripples through the graph, revealing second-order effects before they manifest.</div>
          <div className="space-y-0">
            {effects.map((ef, i) => (
              <div key={i} className="flex items-start gap-[10px] py-[10px]" style={{ borderBottom: "0.5px solid rgba(255,255,255,0.03)" }}>
                <div className="text-[#1e50d4] text-[10px] mt-[1px] flex-shrink-0">→</div>
                <div className="text-[10.5px] text-[#2a3d58] leading-[1.5]"><strong className="text-[#3a5580] font-semibold">{ef.cause}</strong> — {ef.effect}</div>
              </div>
            ))}
          </div>
        </div>
        <div className="relative bg-[#04060b] min-h-[300px] md:min-h-0">
          <canvas ref={canvasRef} style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }} />
        </div>
      </div>
    </div>
  );
}

/* Feature 4: Reasoning Cards */
function ReasoningCards() {
  const cards = [
    { label: "Outcome Probability", value: "74%", icon: <TrendingUp className="w-4 h-4 text-[#0a84ff]" />, sub: "High Confidence" },
    { label: "Asset Volatility", value: "LOW", sub: "Stable Regime" },
    { label: "Sentiment Index", value: "NEUTRAL", sub: "Consistent Data" },
    { label: "Drift Alert", value: "NONE", sub: "Model Calibrated" },
  ];
  return (
    <div className="grid grid-cols-2 gap-4">
      {cards.map((c) => (
        <div key={c.label} className="bg-[#1c1c1e] p-5 rounded-xl border border-white/5 flex flex-col justify-between h-36">
          <span className="text-[#717584] text-xs font-semibold tracking-wide">{c.label}</span>
          <div className="flex items-baseline gap-2">
            <span className="text-white text-2xl font-bold">{c.value}</span>
            {c.icon}
          </div>
          <span className="text-[#a1a1a6] text-xs">{c.sub}</span>
        </div>
      ))}
    </div>
  );
}

/* Feature 5: Market Cards */
function MarketCards() {
  const markets = [
    { name: "NIFTY 50", value: "24,350.25", bar: "w-2/3", forecast: "Forecast: +1.2% Expectation" },
    { name: "SENSEX", value: "79,940.10", bar: "w-1/2", forecast: "Forecast: Stable" },
    { name: "GOLD (XAU)", value: "$2,410.80", bar: "w-4/5", forecast: "Forecast: High Demand" },
    { name: "CRUDE OIL", value: "$82.40", bar: "w-1/3", forecast: "Forecast: Correction Pending" },
  ];
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
      {markets.map((m) => (
        <div key={m.name} className="bg-[#1c1c1e] p-6 rounded-xl border border-white/5 group hover:border-[#0a84ff]/30 transition-all">
          <p className="text-[#717584] text-xs font-semibold tracking-wide mb-2">{m.name}</p>
          <div className="text-white text-2xl font-bold mb-4">{m.value}</div>
          <div className="h-1 bg-white/5 rounded-full overflow-hidden">
            <div className={`h-full bg-[#0a84ff] ${m.bar}`} />
          </div>
          <p className="text-[#0a84ff] text-xs mt-4">{m.forecast}</p>
        </div>
      ))}
    </div>
  );
}

function HeroAuthButtons() {
  const { user, signInGoogle } = useAuth();
  const [showModal, setShowModal] = useState(false);

  if (user) {
    return (
      <Link href={`${basePath}dashboard`}>
        <button className="bg-[#0a84ff] text-white px-10 py-4 rounded-full text-sm font-bold hover:brightness-110 transition-all active:scale-95 flex items-center gap-2">
          Enter Dashboard <ArrowRight className="w-4 h-4" />
        </button>
      </Link>
    );
  }

  return (
    <>
      <button
        onClick={() => signInGoogle()}
        className="bg-[#0a84ff] text-white px-10 py-4 rounded-full text-sm font-bold hover:brightness-110 transition-all active:scale-95 flex items-center gap-2"
      >
        <LogIn className="w-4 h-4" /> Sign In with Google
      </button>
      <button
        onClick={() => setShowModal(true)}
        className="border border-white/20 text-white px-10 py-4 rounded-full text-sm font-bold hover:bg-white/5 transition-all active:scale-95 flex items-center gap-2"
      >
        Sign In with Email
      </button>
      <AuthModal isOpen={showModal} onClose={() => setShowModal(false)} />
    </>
  );
}

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-[#0a0a0f] text-[#a1a1a6] font-sans selection:bg-[#0a84ff]/30">

      {/* Hero */}
      <section className="min-h-screen flex flex-col items-center justify-center text-center px-5 md:px-16">
        <div className="max-w-4xl mx-auto">
          <motion.h1 initial={{ opacity: 0, y: 30 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.8, ease: [0.25, 0.1, 0.25, 1] }}
            className="text-white text-4xl md:text-6xl lg:text-7xl font-extrabold tracking-tighter leading-[1.05] mb-6">
            See the World Before It Happens.
          </motion.h1>
          <motion.p initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.8, delay: 0.15 }}
            className="text-[#a1a1a6] text-lg md:text-xl mb-12 max-w-2xl mx-auto leading-relaxed">
            AI-powered geopolitical intelligence and market prediction. Built for clarity in an age of noise.
          </motion.p>
          <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.8, delay: 0.3 }}
            className="flex flex-col md:flex-row items-center justify-center gap-4 mb-20">
            <HeroAuthButtons />
          </motion.div>
        </div>
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.6, duration: 1 }}
          className="w-full max-w-2xl">
          <HeroGlobe />
        </motion.div>
      </section>

      {/* Section 1: Intelligent Ingestion */}
      <section className="py-32 md:py-40 px-5 md:px-16 max-w-7xl mx-auto">
        <ScrollReveal><IngestionOpsCard /></ScrollReveal>
      </section>

      {/* Section 2: Structured Extraction */}
      <section className="py-32 md:py-40 px-5 md:px-16 max-w-7xl mx-auto">
        <ScrollReveal><ExtractionOpsCard /></ScrollReveal>
      </section>

      {/* Section 3: Living Knowledge Graph */}
      <section className="py-32 md:py-40 px-5 md:px-16 max-w-7xl mx-auto">
        <ScrollReveal><KnowledgeGraphOpsCard /></ScrollReveal>
      </section>

      {/* Section 4: Probabilistic Reasoning */}
      <section className="py-32 md:py-40 px-5 md:px-16 max-w-7xl mx-auto">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-10 items-center">
          <ScrollReveal delay={0.15}><ReasoningCards /></ScrollReveal>
          <ScrollReveal>
            <span className="text-[#0a84ff] text-xs font-semibold tracking-widest uppercase mb-4 block">04 / Analysis</span>
            <h2 className="text-white text-2xl md:text-4xl font-bold tracking-tight leading-tight mb-6">Probabilistic Reasoning</h2>
            <p className="text-[#a1a1a6] text-base md:text-lg leading-relaxed">
              We don't just report what's happening; we calculate what's next. Our Bayesian engines simulate millions of scenarios to give you concrete likelihoods for critical outcomes.
            </p>
          </ScrollReveal>
        </div>
      </section>

      {/* Section 5: Market Forecasting */}
      <section className="py-32 md:py-40 px-5 md:px-16 max-w-7xl mx-auto">
        <div className="text-center mb-12">
          <ScrollReveal>
            <span className="text-[#0a84ff] text-xs font-semibold tracking-widest uppercase mb-4 block">05 / Markets</span>
            <h2 className="text-white text-2xl md:text-4xl font-bold tracking-tight leading-tight mb-6">Market Forecasting</h2>
            <p className="text-[#a1a1a6] text-base md:text-lg max-w-2xl mx-auto">
              Real-time geopolitical impact on global indices. Bridge the gap between world news and asset movement.
            </p>
          </ScrollReveal>
        </div>
        <ScrollReveal delay={0.15}><MarketCards /></ScrollReveal>
      </section>

      {/* Bottom CTA */}
      <section className="py-32 md:py-40 px-5 md:px-16 text-center bg-[#09090c]">
        <ScrollReveal>
          <h2 className="text-white text-3xl md:text-5xl font-bold tracking-tight mb-8">Start seeing clearly.</h2>
          <p className="text-[#a1a1a6] text-lg mb-12 max-w-xl mx-auto">
            Join the world's leading intelligence analysts and hedge fund managers in defining the future.
          </p>
          <Link href={`${basePath}dashboard`}>
            <button className="bg-[#0a84ff] text-white px-12 py-5 rounded-full text-sm font-bold hover:brightness-110 transition-all active:scale-95">
              Get Started
            </button>
          </Link>
        </ScrollReveal>
      </section>

      {/* Footer */}
      <footer className="bg-[#0a0a0f]">
        <div className="flex flex-col md:flex-row justify-between items-center w-full px-5 md:px-16 py-8 max-w-7xl mx-auto border-t border-white/5">
          <div className="text-white text-lg font-bold mb-6 md:mb-0">Global News Monitor</div>
          <div className="flex gap-8 mb-6 md:mb-0">
            <a href="#" className="text-[#a1a1a6] hover:text-white transition-colors">Privacy Policy</a>
            <a href="#" className="text-[#a1a1a6] hover:text-white transition-colors">Terms of Service</a>
            <a href="#" className="text-[#a1a1a6] hover:text-white transition-colors">Contact</a>
          </div>
          <div className="text-[#a1a1a6] text-sm text-center md:text-right">&copy; 2024 Global News Monitor. All rights reserved.</div>
        </div>
      </footer>

    </div>
  );
}
