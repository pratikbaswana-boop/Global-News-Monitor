import { PublicNav, PublicFooter } from "@/components/public-shell";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-10">
      <h2 className="text-white text-lg font-bold mb-3">{title}</h2>
      <div className="text-sm leading-relaxed space-y-3">{children}</div>
    </div>
  );
}

export default function TermsPage() {
  return (
    <div className="min-h-screen bg-[#0a0a0f] text-[#a1a1a6] font-sans">
      <PublicNav />

      <section className="max-w-3xl mx-auto px-5 md:px-16 pt-40 pb-24">
        <p className="text-[11px] tracking-[0.22em] text-[#0a84ff] font-semibold uppercase mb-4">Legal</p>
        <h1 className="text-white text-4xl md:text-5xl font-extrabold tracking-tighter leading-[1.1] mb-4">
          Terms of Service
        </h1>
        <p className="text-sm text-[#717584] mb-12">Last updated: August 2025</p>

        <Section title="1. Acceptance of Terms">
          <p>By accessing or using Aumorphic Harness (&quot;the Service&quot;), you agree to be bound by these Terms of Service. If you do not agree, do not use the Service.</p>
        </Section>

        <Section title="2. Description of Service">
          <p>Harness is an explainable decision-intelligence platform that ingests authorized public signals, produces traceable, evidence-backed assessments, and optionally connects to third-party broker accounts to support trading and paper-trading workflows.</p>
        </Section>

        <Section title="3. Not Financial Advice">
          <p>Content, signals, forecasts, and analytics provided by the Service are for informational purposes only and do not constitute investment, trading, legal, or financial advice. You are solely responsible for any trading or investment decisions you make.</p>
        </Section>

        <Section title="4. Trading Risk Disclosure">
          <p>Trading in financial instruments, including equities, derivatives, and options, carries substantial risk of loss and is not suitable for every investor. Past performance and paper-trading results are not indicative of future or live-money results. You accept full responsibility for any losses incurred through use of live trading features.</p>
        </Section>

        <Section title="5. Account Responsibilities">
          <p>You are responsible for maintaining the confidentiality of your account credentials and for all activity that occurs under your account, including any broker connections you authorize.</p>
        </Section>

        <Section title="6. Acceptable Use">
          <p>You agree not to misuse the Service, including attempting to disrupt its operation, reverse-engineer its systems, or use it for unlawful purposes.</p>
        </Section>

        <Section title="7. Intellectual Property">
          <p>All software, design, and content associated with the Service are the property of Aumorphic or its licensors and may not be copied or redistributed without permission.</p>
        </Section>

        <Section title="8. Disclaimers & Limitation of Liability">
          <p>The Service is provided &quot;as is&quot; without warranties of any kind. To the maximum extent permitted by law, Aumorphic shall not be liable for any indirect, incidental, or consequential damages, including trading losses, arising from your use of the Service.</p>
        </Section>

        <Section title="9. Termination">
          <p>We may suspend or terminate access to the Service at any time for conduct that violates these terms or for any other reason at our discretion.</p>
        </Section>

        <Section title="10. Changes to Terms">
          <p>We may revise these terms from time to time. Continued use of the Service after changes are posted constitutes acceptance of the revised terms.</p>
        </Section>

        <Section title="11. Contact">
          <p>Questions about these terms can be sent to <a href="mailto:team@aumorphic.com" className="text-[#0a84ff] hover:underline">team@aumorphic.com</a>.</p>
        </Section>
      </section>

      <PublicFooter />
    </div>
  );
}
