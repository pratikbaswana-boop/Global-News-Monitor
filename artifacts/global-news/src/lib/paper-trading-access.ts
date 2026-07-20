export const PAPER_TRADING_ALLOWED_EMAILS: string[] = [
  "test@example.com",
  "pratikjat2811@gmail.com",
  "pratikbaswana@gmail.com",
  "vishwakarmaadarsh77@gmail.com",
  "consistenthasher@gmail.com",
  "amarkelotra@gmail.com",
  "abcd.asdfg12@gmail.com",
  "ayushlearning22@gmail.com",
  "pranjal4uyar@gmail.com",
  "itachixoxoxo@gmail.com",
  "k2923149@gmail.com",
  "ayaabalkhi@gmail.com",
];

export function canAccessPaperTrading(email: string | null | undefined): boolean {
  if (!email) return false;
  return PAPER_TRADING_ALLOWED_EMAILS.includes(email.toLowerCase());
}
