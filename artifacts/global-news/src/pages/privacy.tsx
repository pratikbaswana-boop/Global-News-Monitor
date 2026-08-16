import { PublicNav, PublicFooter } from "@/components/public-shell";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-10">
      <h2 className="text-white text-lg font-bold mb-3">{title}</h2>
      <div className="text-sm leading-relaxed space-y-3">{children}</div>
    </div>
  );
}

export default function PrivacyPage() {
  return (
    <div className="min-h-screen bg-[#0a0a0f] text-[#a1a1a6] font-sans">
      <PublicNav />

      <section className="max-w-3xl mx-auto px-5 md:px-16 pt-40 pb-24">
        <p className="text-[11px] tracking-[0.22em] text-[#0a84ff] font-semibold uppercase mb-4">Legal</p>
        <h1 className="text-white text-4xl md:text-5xl font-extrabold tracking-tighter leading-[1.1] mb-4">
          Privacy Policy
        </h1>
        <p className="text-sm text-[#717584] mb-12">Last updated: August 2025</p>

        <Section title="1. Overview">
          <p>
            Aumorphic Harness (&quot;Harness&quot;, &quot;we&quot;, &quot;us&quot;) provides an explainable
            decision-intelligence platform that ingests authorized public signals and, where enabled by the
            user, connects to third-party brokerage accounts for trading and paper-trading features. This
            policy explains what information we collect, how we use it, and the choices you have.
          </p>
        </Section>

        <Section title="2. Information We Collect">
          <p><strong className="text-white">Account information:</strong> name, email address, and authentication identifiers provided via our sign-in provider (Google or email/password).</p>
          <p><strong className="text-white">Usage data:</strong> pages visited, features used, and application diagnostics, collected to improve reliability and product experience.</p>
          <p><strong className="text-white">Broker &amp; trading data:</strong> if you connect a supported broker (e.g. Zerodha Kite), we process order, execution, and position data solely to power the trading, paper-trading, and analytics features you enable. We do not sell this data.</p>
        </Section>

        <Section title="3. How We Use Information">
          <p>We use collected information to operate and improve the platform, provide the intelligence and trading features you request, communicate service updates, and maintain the security and integrity of our systems.</p>
        </Section>

        <Section title="4. Data Sharing">
          <p>We do not sell personal data. We share information only with service providers necessary to operate the platform (e.g. authentication, hosting, and brokerage API providers), and only to the extent required to deliver the service.</p>
        </Section>

        <Section title="5. Data Retention & Security">
          <p>We retain data for as long as your account is active or as needed to provide the service, and apply reasonable technical and organizational measures to protect it. No system is completely secure, and we cannot guarantee absolute security.</p>
        </Section>

        <Section title="6. Your Rights">
          <p>You may request access to, correction of, or deletion of your personal data by contacting us at the address below. You may disconnect any linked broker account at any time from within the application.</p>
        </Section>

        <Section title="7. Changes to This Policy">
          <p>We may update this policy from time to time. Material changes will be reflected on this page with an updated revision date.</p>
        </Section>

        <Section title="8. Contact">
          <p>Questions about this policy can be sent to <a href="mailto:team@aumorphic.com" className="text-[#0a84ff] hover:underline">team@aumorphic.com</a>.</p>
        </Section>
      </section>

      <PublicFooter />
    </div>
  );
}
