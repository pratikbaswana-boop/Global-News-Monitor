import { motion, useInView } from "framer-motion";
import { useRef } from "react";
import { Link } from "wouter";
import { ArrowRight } from "lucide-react";

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

function GlassOrb() {
  return (
    <div className="relative w-64 h-64 md:w-80 md:h-80 lg:w-96 lg:h-96">
      <div
        className="absolute inset-0 rounded-full animate-float"
        style={{
          background:
            "radial-gradient(circle at 35% 35%, rgba(255,255,255,0.15) 0%, transparent 50%), " +
            "radial-gradient(circle at 65% 65%, rgba(10,132,255,0.08) 0%, transparent 50%), " +
            "radial-gradient(circle at 50% 50%, rgba(28,32,39,0.6) 0%, rgba(16,19,27,0.9) 70%)",
          boxShadow:
            "inset -20px -20px 60px rgba(0,0,0,0.5), " +
            "inset 20px 20px 60px rgba(255,255,255,0.05), " +
            "0 0 80px rgba(10,132,255,0.08), " +
            "0 30px 60px rgba(0,0,0,0.4)",
          backdropFilter: "blur(2px)",
        }}
      />
      <div
        className="absolute top-[18%] left-[22%] w-[30%] h-[18%] rounded-full"
        style={{
          background:
            "radial-gradient(ellipse at center, rgba(255,255,255,0.18) 0%, rgba(255,255,255,0.05) 50%, transparent 70%)",
          filter: "blur(4px)",
        }}
      />
    </div>
  );
}

function ScrollReveal({
  children,
  delay = 0,
  className = "",
}: {
  children: React.ReactNode;
  delay?: number;
  className?: string;
}) {
  const ref = useRef(null);
  const isInView = useInView(ref, { once: true, margin: "-80px" });
  return (
    <motion.div
      ref={ref}
      className={className}
      initial={{ opacity: 0, y: 40 }}
      animate={isInView ? { opacity: 1, y: 0 } : { opacity: 0, y: 40 }}
      transition={{ duration: 0.7, ease: [0.25, 0.1, 0.25, 1], delay }}
    >
      {children}
    </motion.div>
  );
}

function NetworkIngressIllustration() {
  return (
    <svg viewBox="0 0 320 240" fill="none" className="w-full h-auto max-w-[320px]">
      <circle cx="160" cy="180" r="6" fill="#0a84ff" opacity="0.9" />
      <line x1="40" y1="40" x2="156" y2="176" stroke="#2a2f3a" strokeWidth="1" />
      <line x1="100" y1="30" x2="158" y2="176" stroke="#2a2f3a" strokeWidth="1" />
      <line x1="160" y1="20" x2="160" y2="174" stroke="#2a2f3a" strokeWidth="1" />
      <line x1="220" y1="30" x2="162" y2="176" stroke="#2a2f3a" strokeWidth="1" />
      <line x1="280" y1="40" x2="164" y2="176" stroke="#2a2f3a" strokeWidth="1" />
      <line x1="20" y1="100" x2="156" y2="178" stroke="#2a2f3a" strokeWidth="1" />
      <line x1="300" y1="100" x2="164" y2="178" stroke="#2a2f3a" strokeWidth="1" />
      <circle cx="40" cy="40" r="3" fill="#3a3f4a" />
      <circle cx="100" cy="30" r="3" fill="#3a3f4a" />
      <circle cx="160" cy="20" r="3" fill="#0a84ff" opacity="0.6" />
      <circle cx="220" cy="30" r="3" fill="#3a3f4a" />
      <circle cx="280" cy="40" r="3" fill="#3a3f4a" />
      <circle cx="20" cy="100" r="3" fill="#3a3f4a" />
      <circle cx="300" cy="100" r="3" fill="#3a3f4a" />
      <circle cx="80" cy="120" r="2.5" fill="#3a3f4a" />
      <circle cx="240" cy="120" r="2.5" fill="#3a3f4a" />
      <line x1="80" y1="120" x2="158" y2="178" stroke="#2a2f3a" strokeWidth="0.5" />
      <line x1="240" y1="120" x2="162" y2="178" stroke="#2a2f3a" strokeWidth="0.5" />
    </svg>
  );
}

function ExtractionIllustration() {
  return (
    <svg viewBox="0 0 320 240" fill="none" className="w-full h-auto max-w-[320px]">
      <rect x="60" y="40" width="200" height="160" rx="12" stroke="#2a2f3a" strokeWidth="1.5" />
      <line x1="90" y1="80" x2="230" y2="80" stroke="#2a2f3a" strokeWidth="1" />
      <line x1="90" y1="110" x2="200" y2="110" stroke="#2a2f3a" strokeWidth="1" />
      <line x1="90" y1="140" x2="180" y2="140" stroke="#2a2f3a" strokeWidth="1" />
      <line x1="90" y1="170" x2="210" y2="170" stroke="#2a2f3a" strokeWidth="1" />
      <rect x="245" y="65" width="55" height="26" rx="6" fill="#0a84ff" opacity="0.15" />
      <rect x="245" y="65" width="55" height="26" rx="6" stroke="#0a84ff" strokeWidth="1" opacity="0.5" />
      <text x="253" y="82" fill="#0a84ff" fontSize="10" fontFamily="Inter, sans-serif" opacity="0.9">CAMEO</text>
      <rect x="210" y="125" width="55" height="26" rx="6" fill="#0a84ff" opacity="0.15" />
      <rect x="210" y="125" width="55" height="26" rx="6" stroke="#0a84ff" strokeWidth="1" opacity="0.5" />
      <text x="218" y="142" fill="#0a84ff" fontSize="10" fontFamily="Inter, sans-serif" opacity="0.9">CODE</text>
    </svg>
  );
}

function GraphIllustration() {
  return (
    <svg viewBox="0 0 320 240" fill="none" className="w-full h-auto max-w-[320px]">
      <circle cx="160" cy="120" r="8" fill="#0a84ff" opacity="0.8" />
      <circle cx="80" cy="70" r="5" fill="#3a3f4a" />
      <circle cx="240" cy="70" r="5" fill="#3a3f4a" />
      <circle cx="80" cy="170" r="5" fill="#3a3f4a" />
      <circle cx="240" cy="170" r="5" fill="#3a3f4a" />
      <circle cx="160" cy="40" r="4" fill="#3a3f4a" />
      <circle cx="160" cy="200" r="4" fill="#3a3f4a" />
      <circle cx="40" cy="120" r="4" fill="#3a3f4a" />
      <circle cx="280" cy="120" r="4" fill="#3a3f4a" />
      <line x1="160" y1="120" x2="80" y2="70" stroke="#2a2f3a" strokeWidth="1" />
      <line x1="160" y1="120" x2="240" y2="70" stroke="#2a2f3a" strokeWidth="1" />
      <line x1="160" y1="120" x2="80" y2="170" stroke="#2a2f3a" strokeWidth="1" />
      <line x1="160" y1="120" x2="240" y2="170" stroke="#2a2f3a" strokeWidth="1" />
      <line x1="160" y1="120" x2="160" y2="40" stroke="#2a2f3a" strokeWidth="1" />
      <line x1="160" y1="120" x2="160" y2="200" stroke="#2a2f3a" strokeWidth="1" />
      <line x1="160" y1="120" x2="40" y2="120" stroke="#2a2f3a" strokeWidth="1" />
      <line x1="160" y1="120" x2="280" y2="120" stroke="#2a2f3a" strokeWidth="1" />
    </svg>
  );
}

function ReasoningIllustration() {
  return (
    <svg viewBox="0 0 320 240" fill="none" className="w-full h-auto max-w-[320px]">
      <circle cx="160" cy="80" r="28" stroke="#2a2f3a" strokeWidth="1.5" fill="none" />
      <circle cx="160" cy="80" r="8" fill="#0a84ff" opacity="0.7" />
      <circle cx="80" cy="160" r="20" stroke="#2a2f3a" strokeWidth="1.5" fill="none" />
      <circle cx="80" cy="160" r="6" fill="#3a3f4a" />
      <circle cx="160" cy="180" r="20" stroke="#2a2f3a" strokeWidth="1.5" fill="none" />
      <circle cx="160" cy="180" r="6" fill="#3a3f4a" />
      <circle cx="240" cy="160" r="20" stroke="#2a2f3a" strokeWidth="1.5" fill="none" />
      <circle cx="240" cy="160" r="6" fill="#3a3f4a" />
      <circle cx="120" cy="120" r="20" stroke="#2a2f3a" strokeWidth="1.5" fill="none" />
      <circle cx="120" cy="120" r="6" fill="#3a3f4a" />
      <line x1="160" y1="108" x2="120" y2="114" stroke="#2a2f3a" strokeWidth="1" />
      <line x1="160" y1="108" x2="160" y2="160" stroke="#2a2f3a" strokeWidth="1" />
      <line x1="160" y1="108" x2="240" y2="140" stroke="#2a2f3a" strokeWidth="1" />
      <line x1="120" y1="126" x2="80" y2="140" stroke="#2a2f3a" strokeWidth="1" />
    </svg>
  );
}

function ForecastingIllustration() {
  return (
    <svg viewBox="0 0 320 240" fill="none" className="w-full h-auto max-w-[320px]">
      <line x1="40" y1="200" x2="280" y2="200" stroke="#2a2f3a" strokeWidth="1" />
      <line x1="40" y1="200" x2="40" y2="40" stroke="#2a2f3a" strokeWidth="1" />
      <polyline
        points="40,180 70,170 100,175 130,150 160,155 190,120 220,110 250,80 280,60"
        fill="none"
        stroke="#0a84ff"
        strokeWidth="2"
        opacity="0.7"
      />
      <circle cx="190" cy="120" r="4" fill="#0a84ff" opacity="0.9" />
      <circle cx="250" cy="80" r="4" fill="#0a84ff" opacity="0.9" />
      <rect x="200" y="50" width="70" height="24" rx="6" fill="#0a84ff" opacity="0.15" />
      <rect x="200" y="50" width="70" height="24" rx="6" stroke="#0a84ff" strokeWidth="1" opacity="0.5" />
      <text x="208" y="66" fill="#0a84ff" fontSize="10" fontFamily="Inter, sans-serif" opacity="0.9">+2.4%</text>
    </svg>
  );
}

const features = [
  {
    title: "Intelligent Ingestion",
    description:
      "500+ global sources monitored in real time. From primary diplomatic cables to high-velocity social signals. Every stream is filtered for authenticity and noise reduction.",
    illustration: <NetworkIngressIllustration />,
    align: "left" as const,
  },
  {
    title: "Structured Extraction",
    description:
      "Every event is CAMEO-coded by AI. No noise. Only signal. Each article is decomposed into structured geopolitical primitives with zero human latency.",
    illustration: <ExtractionIllustration />,
    align: "right" as const,
  },
  {
    title: "Living Knowledge Graph",
    description:
      "Actors, actions, relationships. Continuously evolving. Our Neo4j-backed graph learns from every new event, surfacing non-obvious connections between entities.",
    illustration: <GraphIllustration />,
    align: "left" as const,
  },
  {
    title: "Probabilistic Reasoning",
    description:
      "Four AI agents debate every scenario. Analyst, Historian, Forecaster, and Devil's Advocate. Consensus emerges from structured disagreement.",
    illustration: <ReasoningIllustration />,
    align: "right" as const,
  },
  {
    title: "Market Forecasting",
    description:
      "Directional predictions for NIFTY, SENSEX, commodities. Scored. Resolved. Every prediction feeds back into the system, sharpening future accuracy.",
    illustration: <ForecastingIllustration />,
    align: "left" as const,
  },
];

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-[#10131b] text-[#e0e2ed] font-sans selection:bg-[#0a84ff]/30">
      {/* Hero */}
      <section className="relative min-h-screen flex flex-col items-center justify-center px-6 overflow-hidden">
        <div className="absolute inset-0 opacity-20">
          <div
            className="absolute top-1/4 left-1/4 w-96 h-96 rounded-full"
            style={{
              background: "radial-gradient(circle, rgba(10,132,255,0.06) 0%, transparent 70%)",
              filter: "blur(60px)",
            }}
          />
          <div
            className="absolute bottom-1/4 right-1/4 w-80 h-80 rounded-full"
            style={{
              background: "radial-gradient(circle, rgba(255,255,255,0.03) 0%, transparent 70%)",
              filter: "blur(60px)",
            }}
          />
        </div>

        <motion.div
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 1, ease: [0.25, 0.1, 0.25, 1] }}
          className="relative z-10 flex flex-col items-center"
        >
          <GlassOrb />
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 30 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8, delay: 0.3, ease: [0.25, 0.1, 0.25, 1] }}
          className="relative z-10 text-center mt-12 max-w-3xl"
        >
          <h1
            className="text-4xl sm:text-5xl md:text-6xl lg:text-7xl font-bold tracking-tight leading-[1.1]"
            style={{ letterSpacing: "-0.04em" }}
          >
            See the World
            <br />
            Before It Happens.
          </h1>
          <p className="mt-6 text-base sm:text-lg md:text-xl text-[#8b91a0] max-w-xl mx-auto leading-relaxed">
            AI-powered geopolitical intelligence and market prediction.
            <br className="hidden sm:block" />
            Built for clarity.
          </p>
          <div className="mt-10">
            <Link href={`${basePath}dashboard`}>
              <button className="inline-flex items-center gap-2 px-8 py-3.5 rounded-full bg-[#0a84ff] text-white font-semibold text-sm tracking-wide hover:bg-[#0066cc] transition-colors duration-200 group">
                Enter Dashboard
                <ArrowRight className="w-4 h-4 group-hover:translate-x-0.5 transition-transform" />
              </button>
            </Link>
          </div>
        </motion.div>

        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 1.2, duration: 0.6 }}
          className="absolute bottom-10 left-1/2 -translate-x-1/2"
        >
          <div className="w-5 h-8 rounded-full border-2 border-[#414754] flex items-start justify-center pt-1.5">
            <motion.div
              animate={{ y: [0, 8, 0] }}
              transition={{ repeat: Infinity, duration: 1.8, ease: "easeInOut" }}
              className="w-1 h-1.5 rounded-full bg-[#8b91a0]"
            />
          </div>
        </motion.div>
      </section>

      {/* Features */}
      {features.map((feature, i) => {
        const bg =
          i % 2 === 0
            ? "bg-[#10131b]"
            : "bg-[#0b0e15]";
        return (
          <section
            key={feature.title}
            className={`py-24 md:py-32 lg:py-40 px-6 ${bg}`}
          >
            <div className="max-w-6xl mx-auto">
              <div
                className={`flex flex-col ${
                  feature.align === "right" ? "md:flex-row-reverse" : "md:flex-row"
                } items-center gap-12 md:gap-20 lg:gap-28`}
              >
                <ScrollReveal
                  delay={0}
                  className={`flex-1 ${feature.align === "right" ? "md:text-right" : "md:text-left"}`}
                >
                  <h2
                    className="text-2xl sm:text-3xl md:text-4xl font-bold tracking-tight leading-tight"
                    style={{ letterSpacing: "-0.03em" }}
                  >
                    {feature.title}
                  </h2>
                  <p className="mt-5 text-base md:text-lg text-[#8b91a0] leading-relaxed max-w-lg">
                    {feature.description}
                  </p>
                </ScrollReveal>

                <ScrollReveal delay={0.15} className="flex-1 flex justify-center">
                  <div className="w-full max-w-[320px] md:max-w-none">
                    {feature.illustration}
                  </div>
                </ScrollReveal>
              </div>
            </div>
          </section>
        );
      })}

      {/* Bottom CTA */}
      <section className="py-24 md:py-32 lg:py-40 px-6 bg-[#10131b] text-center">
        <ScrollReveal>
          <h2
            className="text-3xl sm:text-4xl md:text-5xl font-bold tracking-tight"
            style={{ letterSpacing: "-0.03em" }}
          >
            Start seeing clearly.
          </h2>
          <div className="mt-10">
            <Link href={`${basePath}dashboard`}>
              <button className="inline-flex items-center gap-2 px-8 py-3.5 rounded-full bg-[#0a84ff] text-white font-semibold text-sm tracking-wide hover:bg-[#0066cc] transition-colors duration-200 group">
                Enter Dashboard
                <ArrowRight className="w-4 h-4 group-hover:translate-x-0.5 transition-transform" />
              </button>
            </Link>
          </div>
        </ScrollReveal>
      </section>

      {/* Footer */}
      <footer className="py-8 px-6 bg-[#0b0e15] border-t border-[#181c23]">
        <div className="max-w-6xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-4">
          <span className="text-xs text-[#8b91a0]">
            © 2026 Global News Monitor
          </span>
          <span className="text-xs text-[#8b91a0]">
            Intelligence, synthesized.
          </span>
        </div>
      </footer>

      <style>{`
        @keyframes float {
          0%, 100% { transform: translateY(0px); }
          50% { transform: translateY(-12px); }
        }
        .animate-float {
          animation: float 6s ease-in-out infinite;
        }
      `}</style>
    </div>
  );
}
