/**
 * Changelog content (public /changelog page).
 *
 * Honesty rule: every entry describes work that is actually shipped and
 * verified in this repository (see NILA.md and this session's changes). No
 * roadmap item is listed as done. Dates are the day a change reached the site.
 */

export type ChangeKind = "Added" | "Improved" | "Fixed";

export type ChangelogChange = {
  kind: ChangeKind;
  text: string;
};

export type ChangelogRelease = {
  date: string; // ISO date (YYYY-MM-DD)
  title: string;
  summary: string;
  changes: ChangelogChange[];
};

export const CHANGELOG: ChangelogRelease[] = [
  {
    date: "2026-11-05",
    title: "Clearer setup and steadier diagnostics",
    summary:
      "Made it obvious what is configured, what still needs attention, and kept the dashboard honest when Discord is briefly slow.",
    changes: [
      {
        kind: "Added",
        text: "A Feature readiness checklist on the dashboard Overview covering Tickets, Welcome, Goodbye, Auto-roles, Reaction roles, Auto-Mod, Audit logging, and Surveys — each shown as ready, pending, or unknown with a link to configure it.",
      },
      {
        kind: "Improved",
        text: "The Health & Diagnostics page now leads with an at-a-glance summary, a “show issues only” filter, one-click copy of the diagnostic data, and direct links to fix any degraded service.",
      },
      {
        kind: "Fixed",
        text: "The developer overview no longer bounces to a full error page when Discord is temporarily unreachable; it renders with clearly labelled unknown states instead.",
      },
      {
        kind: "Fixed",
        text: "The browser tab icon now matches the Nila three-tier river-wave brand mark used across the site.",
      },
    ],
  },
  {
    date: "2026-11-04",
    title: "Legal clarity and smoother sign-in",
    summary: "Operator-reviewed policy pages and a sign-in flow that brings you back where you left off.",
    changes: [
      {
        kind: "Added",
        text: "Privacy Policy and Terms of Service pages describing exactly what Nila collects, how sessions are stored, and your deletion routes.",
      },
      {
        kind: "Improved",
        text: "Signing in with Discord now returns you to the exact dashboard page you were heading to, instead of dropping you at the server picker.",
      },
    ],
  },
  {
    date: "2026-10-28",
    title: "Design, welcome flows, and community tools",
    summary: "The core surfaces communities use day to day, all available in Discord today.",
    changes: [
      {
        kind: "Added",
        text: "Component V2 Studio — a visual message builder with a Simple mode for quick edits and an Expert mode with a live, API-accurate preview.",
      },
      {
        kind: "Added",
        text: "Welcome, goodbye, and auto-role messages, including custom welcome cards rendered with the server’s own branding.",
      },
      {
        kind: "Added",
        text: "Reaction roles, giveaways, and the community counting game.",
      },
      {
        kind: "Added",
        text: "A full ticket system: categories, opening forms, panels, staff queues, transcripts, satisfaction surveys, and analytics.",
      },
      {
        kind: "Improved",
        text: "Auto-Mod is configurable from both Discord and the web console, with every enforcement decision passing fail-closed checks regardless of where a rule was saved.",
      },
    ],
  },
];
