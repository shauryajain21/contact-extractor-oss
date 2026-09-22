import type { Activity } from "../../src/types.js";
import { chat, commit, inboundEmail, outboundEmail } from "./helpers.js";

const ana = { name: "Ana Garcia", email: "ana@acme-labs.io" };
const dana = { name: "Dana Lee", email: "dana@northwind.io" };

/** A day of commits, chats, customer mail, a job application, SEO spam, a teammate, a friend and a meeting. */
export function mixedFixture(): Activity[] {
  return [
    commit("git:worklog:a1", "worklog", "Add IMAP source", "2026-09-21T08:00:00Z"),
    commit("git:worklog:a2", "worklog", "Fix thread merge", "2026-09-21T08:30:00Z"),
    commit("git:worklog:a3", "worklog", "Fix thread merge", "2026-09-21T08:40:00Z"),
    chat("cursor:c1", "worklog", "Design digest schema", "2026-09-21T09:30:00Z"),
    chat("cursor:c2", "billing-api", "Debug Stripe webhook retries", "2026-09-21T13:00:00Z"),
    inboundEmail("imap:1", ana, "Pricing for 20 seats", "Hi Sam,\n\nCould you quote 20 seats on the team plan?", {
      threadId: "t-acme",
      at: "2026-09-21T09:00:00Z",
      url: "https://mail.example/1",
    }),
    outboundEmail("imap:2", ana, "Re: Pricing for 20 seats", "Hi Ana, 20 seats at $40/seat/month. Want the order form?", {
      threadId: "t-acme",
      at: "2026-09-21T10:00:00Z",
      url: "https://mail.example/2",
    }),
    inboundEmail("imap:3", dana, "Seat expansion", "Hi Sam,\n\nWe're hiring fast and need 20 more seats. Pricing?", {
      threadId: "t-north",
      at: "2026-09-21T11:00:00Z",
    }),
    inboundEmail(
      "imap:4",
      { name: "Priya N", email: "priya.n@gmail.com" },
      "Internship application",
      "Hi,\n\nI am looking for an internship. Please find attached my CV.",
      { threadId: "t-job", at: "2026-09-21T12:00:00Z" }
    ),
    inboundEmail(
      "imap:5",
      { email: "mark@rankboost-agency.com" },
      "Rank #1",
      "We offer SEO services and backlinks. Reply YES.",
      { threadId: "t-seo", at: "2026-09-21T12:30:00Z" }
    ),
    inboundEmail("imap:6", { name: "Kai", email: "kai@worklog.dev" }, "Standup", "Shipped the parser.", {
      threadId: "t-kai",
      at: "2026-09-21T13:30:00Z",
    }),
    inboundEmail("imap:7", { name: "Chris Park", email: "chris.park@gmail.com" }, "Dinner Friday?", "Are you free?", {
      threadId: "t-chris",
      at: "2026-09-21T14:00:00Z",
    }),
    {
      id: "cal:1",
      source: "calendar",
      kind: "event",
      at: "2026-09-21T15:00:00Z",
      title: "Globex intro call",
      text: "",
      participants: [
        { name: "Sam Rivera", email: "sam@worklog.dev", role: "attendee" },
        { name: "Omar Haddad", email: "omar@globex.com", role: "attendee" },
      ],
      fromMe: false,
    },
  ];
}
