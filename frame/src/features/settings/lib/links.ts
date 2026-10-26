import * as m from "$shared/i18n/messages";

/** The fork's own home. There is no Neuxie site yet, so the repository is it. */
export const WEBSITE = "https://github.com/neuxora/neuxie-browser";

export const links = [
  { id: "website", url: WEBSITE, label: () => m.about_link_website() },
  { id: "github", url: WEBSITE, label: () => "GitHub" },
  {
    id: "upstream",
    url: "https://github.com/zephium-browser/Zephium",
    label: () => "Based on Zephium",
  },
] as const;
