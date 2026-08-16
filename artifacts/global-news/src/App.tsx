import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import Dashboard from "@/pages/dashboard";
import Trending from "@/pages/trending";
import Sources from "@/pages/sources";
import Intelligence from "@/pages/intelligence";
import Trading from "@/pages/trading";
import PaperTrading from "@/pages/paper-trading";
import AmfPage from "@/pages/amf";
import LandingPage from "@/pages/landing";
import ContactPage from "@/pages/contact";
import PrivacyPage from "@/pages/privacy";
import TermsPage from "@/pages/terms";
import ReportPage from "@/pages/report";
import { AuthProvider } from "@/hooks/use-auth";
import { AuthGuard } from "@/components/auth/auth-guard";
import { PAPER_TRADING_ALLOWED_EMAILS } from "@/lib/paper-trading-access";
import { useAppOpenTracking, usePageViewTracking } from "@/hooks/use-engagement";

const queryClient = new QueryClient();

function EngagementTracker() {
  useAppOpenTracking();
  usePageViewTracking();
  return null;
}

function Router() {
  return (
    <Switch>
      <Route path="/" component={LandingPage} />
      <Route path="/contact" component={ContactPage} />
      <Route path="/privacy" component={PrivacyPage} />
      <Route path="/terms" component={TermsPage} />
      <Route path="/dashboard">
        {() => (
          <AuthGuard>
            <Dashboard />
          </AuthGuard>
        )}
      </Route>
      <Route path="/trending">
        {() => (
          <AuthGuard>
            <Trending />
          </AuthGuard>
        )}
      </Route>
      <Route path="/sources">
        {() => (
          <AuthGuard>
            <Sources />
          </AuthGuard>
        )}
      </Route>
      <Route path="/intelligence">
        {() => (
          <AuthGuard>
            <Intelligence />
          </AuthGuard>
        )}
      </Route>
      <Route path="/trading">
        {() => (
          <AuthGuard>
            <Trading />
          </AuthGuard>
        )}
      </Route>
      <Route path="/paper-trading">
        {() => (
          <AuthGuard allowedEmails={PAPER_TRADING_ALLOWED_EMAILS}>
            <PaperTrading />
          </AuthGuard>
        )}
      </Route>
      <Route path="/report">
        {() => (
          <AuthGuard>
            <ReportPage />
          </AuthGuard>
        )}
      </Route>
      <Route path="/amf">
        {() => (
          <AuthGuard>
            <AmfPage />
          </AuthGuard>
        )}
      </Route>
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <AuthProvider>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
            <EngagementTracker />
            <Router />
          </WouterRouter>
          <Toaster />
        </TooltipProvider>
      </QueryClientProvider>
    </AuthProvider>
  );
}

export default App;
