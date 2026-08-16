import { Mail, MapPin } from "lucide-react";
import { PublicNav, PublicFooter } from "@/components/public-shell";

export default function ContactPage() {
  return (
    <div className="min-h-screen bg-[#0a0a0f] text-[#a1a1a6] font-sans">
      <PublicNav />

      <section className="max-w-3xl mx-auto px-5 md:px-16 pt-40 pb-24 text-center">
        <p className="text-[11px] tracking-[0.22em] text-[#0a84ff] font-semibold uppercase mb-4">Get in touch</p>
        <h1 className="text-white text-4xl md:text-5xl font-extrabold tracking-tighter leading-[1.1] mb-6">
          Let&apos;s talk about Decision Intelligence.
        </h1>
        <p className="text-lg leading-relaxed mb-12 max-w-xl mx-auto">
          Whether you&apos;re exploring a strategic partnership, a pilot deployment, or just want to learn
          more about HARNESS, we&apos;d like to hear from you.
        </p>

        <div className="flex flex-col items-center gap-6">
          <a
            href="mailto:team@aumorphic.com"
            className="inline-flex items-center gap-3 bg-[#0a84ff] text-white px-8 py-4 rounded-full text-sm font-bold hover:brightness-110 transition-all active:scale-95"
          >
            <Mail className="w-4 h-4" /> team@aumorphic.com
          </a>
          <div className="flex items-center gap-2 text-sm text-[#a1a1a6]">
            <MapPin className="w-4 h-4" /> India
          </div>
        </div>
      </section>

      <PublicFooter />
    </div>
  );
}
