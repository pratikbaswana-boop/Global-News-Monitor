import { Link, useLocation } from "wouter";

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

const NAV_LINKS = [
  { href: "contact", label: "Contact" },
];

export function PublicNav() {
  const [location] = useLocation();
  return (
    <nav className="fixed top-0 inset-x-0 z-30 backdrop-blur-md bg-[#0a0a0f]/70 border-b border-white/5">
      <div className="max-w-7xl mx-auto px-5 md:px-16 h-16 flex items-center justify-between">
        <Link href={basePath || "/"}>
          <a className="flex items-center gap-2.5">
            <img src={`${basePath}/aumorphic-logo.png`} alt="Aumorphic" className="h-6 w-auto" />
            <span className="text-white font-bold text-base tracking-tight">Harness</span>
          </a>
        </Link>
        <div className="flex items-center gap-8">
          {NAV_LINKS.map((l) => (
            <Link key={l.href} href={`${basePath}${l.href}`}>
              <a className={`text-sm transition-colors ${location === `/${l.href}` ? "text-white" : "text-[#a1a1a6] hover:text-white"}`}>
                {l.label}
              </a>
            </Link>
          ))}
        </div>
      </div>
    </nav>
  );
}

export function PublicFooter() {
  return (
    <footer className="bg-[#0a0a0f]">
      <div className="flex flex-col md:flex-row justify-between items-center w-full px-5 md:px-16 py-8 max-w-7xl mx-auto border-t border-white/5">
        <div className="flex items-center gap-2 mb-6 md:mb-0">
          <img src={`${basePath}/aumorphic-logo.png`} alt="Aumorphic" className="h-6 w-auto" />
          <span className="text-white text-lg font-bold">Harness</span>
        </div>
        <div className="flex gap-8 mb-6 md:mb-0">
          <Link href={`${basePath}privacy`}><a className="text-[#a1a1a6] hover:text-white transition-colors">Privacy Policy</a></Link>
          <Link href={`${basePath}terms`}><a className="text-[#a1a1a6] hover:text-white transition-colors">Terms of Service</a></Link>
          <Link href={`${basePath}contact`}><a className="text-[#a1a1a6] hover:text-white transition-colors">Contact</a></Link>
        </div>
        <div className="text-[#a1a1a6] text-sm text-center md:text-right">&copy; 2025 Aumorphic Harness. All rights reserved.</div>
      </div>
    </footer>
  );
}
