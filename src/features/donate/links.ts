/**
 * Donation and project links. Leave a value empty to hide it; if every donation link is empty,
 * the Support button disappears entirely (handy for forks).
 */
export const LINKS = {
  kofi: "nhamhv", // Ko-fi username, e.g. "nhamhv" → https://ko-fi.com/nhamhv
  paypal: "nhamhv", // PayPal.Me username, e.g. "nhamhv" → https://paypal.me/nhamhv
  buyMeACoffee: "", // Buy Me a Coffee username
  githubSponsors: "", // GitHub username enrolled in Sponsors
  repo: "https://github.com/nhamhv/DiskLens",
};

export const DONATIONS = [
  { id: "kofi", url: LINKS.kofi && `https://ko-fi.com/${LINKS.kofi}`, color: "#FF5E5B", text: "#fff" },
  { id: "paypal", url: LINKS.paypal && `https://paypal.me/${LINKS.paypal}`, color: "#003087", text: "#fff" },
  { id: "bmc", url: LINKS.buyMeACoffee && `https://buymeacoffee.com/${LINKS.buyMeACoffee}`, color: "#FFDD00", text: "#000" },
  { id: "sponsors", url: LINKS.githubSponsors && `https://github.com/sponsors/${LINKS.githubSponsors}`, color: "#BF3989", text: "#fff" },
].filter((d) => d.url);

export const hasDonations = DONATIONS.length > 0;
