// The invented messages behind "Check the message reader" (reader-check.ts), with what each should give.
// Written on 15 Nov 2026, before Apple's model was tried on them, and never used to tune the reader: they are how
// Apple's model is measured on a real iPhone, against the rules alone. Every name, school, number and message is
// made up (phone numbers from Ofcom's drama ranges).
import type { TestMessage } from "./score-lib";

export const CHECK_MESSAGES: TestMessage[] = [
  {
    id: "photo-letter",
    today: "2026-11-23",
    text: "St Mary's Primary School\nDear Parents and Carers,\n\nYear 2 have been learning about the Great Fire of London and on Thursday 3rd December we will be holding a special assembly to share our work. Parents are welcome to join us in the hall at 9am.\n\nChildren may come to school dressed as a Londoner from 1666 on the day if they wish.\n\nKind regards,\nMrs Okafor\nYear 2 Teacher",
    expect: [{ type: "event", date: "2026-12-03", title: ["assembly"] }],
  },
  {
    id: "nursery-party",
    today: "2026-11-23",
    text: "Tiny Steps Nursery: Our Christmas party will be on Friday 18th December. Children can wear party clothes. Please let us know by Friday 11th December if your child has any food allergies we don't already know about.",
    expect: [
      { type: "event", date: "2026-12-18", title: ["party"] },
      { type: "forward", date: "2026-12-11", title: ["let us know", "allerg"] },
    ],
  },
  {
    id: "swim-cancelled",
    today: "2026-11-23",
    text: "[22/11/2026, 18:40] Coach Dan: No swimming squad this Wednesday as the pool is closed for repairs. Back to normal next week.\n[22/11/2026, 18:42] Amira: Thanks Dan!",
    expect: [{ type: "closure", date: "2026-11-25", title: ["swimming", "squad", "pool"] }],
  },
  {
    id: "jabs",
    today: "2026-11-23",
    children: ["Noah"],
    text: "Reminder from Riverside Surgery: Noah has an appointment for his 12 month jabs on Tuesday 1st December at 10:20. To cancel reply CANCEL.",
    expect: [{ type: "event", date: "2026-12-01", title: ["appointment", "jabs"] }],
  },
  {
    id: "options-evening",
    today: "2026-11-23",
    text: "Subject: Year 9 options evening\n\nDear Parent/Carer,\n\nOur Year 9 options evening takes place on Wednesday 9 December, 6pm to 8pm. Option forms must be returned by Friday 15 January.\n\nMr Clarke\nHead of Year 9",
    expect: [
      { type: "event", date: "2026-12-09", title: ["options evening", "evening"] },
      { type: "forward", date: "2027-01-15", title: ["form", "return"] },
    ],
  },
  {
    id: "lost-bottle",
    today: "2026-11-23",
    text: "[23/11/2026, 07:55] Becky: Morning all! Has anyone seen a blue water bottle with a dinosaur on it?\n[23/11/2026, 08:02] Tom: Not seen it sorry\n[23/11/2026, 08:10] Becky: No worries, will check lost property",
    expect: [],
  },
  {
    id: "jumper-day",
    today: "2026-11-23",
    text: "Save the Children Christmas Jumper Day is Thursday 10th December. Children can wear a festive jumper with their uniform for a £1 donation.",
    expect: [{ type: "event", date: "2026-12-10", title: ["jumper"] }],
  },
  {
    id: "club-list",
    today: "2026-11-23",
    text: "Spring term clubs\nMonday: Netball 3.15-4.15pm\nWednesday: Choir 12.30pm\nThursday: Chess club 3.15-4.30pm\nClubs start the week of 11th January.",
    expect: [
      { type: "weekly", weekdays: [0], title: ["netball"] },
      { type: "weekly", weekdays: [2], title: ["choir"] },
      { type: "weekly", weekdays: [3], title: ["chess"] },
    ],
    maybe: [{ type: "event", date: "2027-01-11" }],
  },
  {
    id: "non-uniform",
    today: "2026-11-25",
    text: "Just a reminder that tomorrow is non-uniform day to raise money for the Year 6 trip. Please bring £1 in an envelope.",
    expect: [{ type: "event", date: "2026-11-26", title: ["non-uniform"] }],
  },
  {
    id: "party-card",
    today: "2026-11-23",
    children: ["Ruby"],
    text: "You're invited to Isla's 5th birthday party! Saturday 12th December, 10am-12pm at Funky Monkeys soft play. RSVP to Jess on 07700 900123 by 5th December.",
    expect: [
      { type: "event", date: "2026-12-12", title: ["party"] },
      { type: "forward", date: "2026-12-05", title: ["rsvp"] },
    ],
  },
  {
    id: "staff-training",
    today: "2026-11-23",
    text: "Please note school will be closed to pupils on Monday 4th January for staff training. Spring term starts for children on Tuesday 5th January.",
    expect: [
      { type: "closure", date: "2027-01-04", title: ["closed", "training"] },
      { type: "event", date: "2027-01-05", title: ["term"] },
    ],
  },
  {
    id: "booking-open",
    today: "2026-11-23",
    text: "Parents' evening appointments for Reception are now open on SchoolCloud. Evenings are Tuesday 1st and Wednesday 2nd December. Please book by Friday 27th November.",
    expect: [
      { type: "event", date: "2026-12-01", title: ["evening"] },
      { type: "forward", date: "2026-11-27", title: ["book"] },
    ],
    maybe: [{ type: "event", date: "2026-12-02" }],
  },
  {
    id: "pe-swap",
    today: "2026-11-23",
    text: "From next week Class 4 will have PE on Mondays and Fridays instead of Tuesdays. Please make sure kits are in school.",
    expect: [{ type: "weekly", weekdays: [0, 4], title: ["pe"] }],
  },
  {
    id: "panto-chat",
    today: "2026-11-23",
    text: "[23/11/2026, 20:15] Priya: Did everyone get the letter about the panto trip? It's on Tuesday 15th Dec and they need £14 on ParentPay by this Friday\n[23/11/2026, 20:17] Lucy: Yes, paid already 👍",
    expect: [
      { type: "event", date: "2026-12-15", title: ["panto", "trip"] },
      { type: "forward", date: "2026-11-27", title: ["£14", "pay"] },
    ],
  },
  {
    id: "coat-advert",
    today: "2026-11-23",
    text: "Get 15% off kids' winter coats this weekend only at Little Threads! Use code SNOW15 online.",
    expect: [],
  },
  {
    id: "dentist-recall",
    today: "2026-11-23",
    children: ["Zara"],
    text: "Smile Bright Dental: It's time for Zara's check-up. Please call us on 0161 496 0000 to book an appointment before the end of January.",
    expect: [{ type: "forward", title: ["book", "check-up", "call", "appointment"] }],
  },
  {
    id: "two-children",
    today: "2026-11-23",
    children: ["Leo", "Maya"],
    text: "Leo's football match is on Saturday 28th November at 9.30am, kick off at Westfield Park. Maya has her ballet exam on Sunday 6th December at 2pm, hair in a bun please.",
    expect: [
      { type: "event", date: "2026-11-28", title: ["football", "match"] },
      { type: "event", date: "2026-12-06", title: ["ballet", "exam"] },
    ],
  },
];
