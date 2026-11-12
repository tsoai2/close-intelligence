# Getting started

No technical background needed. Allow about fifteen minutes.

## 1. Open the app

Ask whoever set it up for the address (on your own computer it is
<http://localhost:4600>). You land in **Demo**, marked by an amber stripe across the top.

Demo is a fictional company, Halcyon Ridge Distribution Co. Every name, balance and
document in it is made up. You can click anything: nothing is sent, and **Reset demo**
(under your initials, top right → Demo controls) puts it all back.

## 2. Five things to try in Demo

1. **Today** — the opening screen. "Close at a glance" shows the projected finish date and
   the one task holding it. Click the projected date or any number to see how it was
   calculated and the records behind it.
2. **Process Map** — the constellation of tasks. The amber path is the critical path: the
   chain that sets the finish date. Click a node to see who owns it, what it is waiting
   on and what it would delay. **Table** shows the same thing as a list. **What-if** lets
   you test a change (a faster handoff, a second reviewer) without altering anything.
3. **Close → Requests** — find "Period-end inventory report". Mark it received and accept
   it, then watch the waiting task become ready and the projected date move.
4. **Insights** — findings the rules engine produced from the data, each with its evidence,
   how much data it rests on, and what it could not see. Turn one into an improvement
   proposal. Note the covenant certificate: rarely opened, but protected because a
   control depends on it. "No views here" is never treated as "not needed".
5. **Assistant** (the sparkle icon) — ask "What is holding the close?". In Demo the answer
   is a clearly labelled sample built from the demo records by fixed rules, not live AI,
   unless you connect an OpenAI key in Demo (see below).

Under your initials you can also preview other roles (reviewer, preparer, executive,
auditor, outside contact) and switch scenario: On track, Upstream delay, Reviewer
unavailable, Improved process.

### Making the demo your own

- **Company name:** Settings → Guided setup → Company and entities → type a name → Save
  name. It appears in the header, reports and exports. The figures stay fictional and the
  screen stays marked Demo.
- **Live AI in Demo:** Settings → AI Connection → paste an OpenAI API key → Test and save →
  choose a model. The assistant then sends the fictional demo records needed for each
  question to OpenAI and shows the real answer, labelled "Live AI on fictional demo data".
  Disconnect the key to go back to sample responses.
- Both are kept when you press Reset demo or change scenario.

An OpenAI API key comes from platform.openai.com and is billed separately from a ChatGPT
subscription; a ChatGPT login is not an API key.

### How to read the labels

| Label | Meaning |
| --- | --- |
| Recorded | A fact someone entered or imported |
| Rules-based | Calculated by fixed rules from recorded facts; click to see the working |
| AI hypothesis | A suggestion from the assistant; never treated as fact until a person confirms it |
| Confirmed | A person reviewed and accepted it |
| Scenario | A what-if assumption; never changes the real plan until published |

Timeliness ("will we finish on time?") and quality ("is the work sound?") are always
shown separately. A finished checklist does not prove the numbers are right.

## 3. Start your own close in Live

1. Flip the switch at the top to **Live**. The stripe disappears. Live starts empty and
   never contains demo records.
2. Create the first account. That person becomes the administrator. Passwords need at
   least 10 characters with a letter and a number.
3. Follow **Settings → Guided setup**: company and entities, close calendar (Day 0 is the
   last day of the period; working days are counted from it), then a checklist. You can
   start from the standard template, the optional distributor template, or **import your
   own checklist** from a spreadsheet (a template file is offered in the import screen).
4. Open a period. Tasks, due dates and dependencies are created from the template.
5. **Close → Financials → Import trial balance.** The wizard shows what it understood,
   flags anything that does not balance, and lets you undo an import.
6. **Settings → Team and roles → Add person.** Choose a role and an initial password and
   pass it on securely. The app does not send email. Each person can change their
   password from the menu under their initials; an administrator can reset it.

Preparing and approving the same item is blocked by default. A small team can allow it
in Settings → Policies, in which case each such approval is recorded as an exception.

## 4. What the app will not do on its own

- It does not send email. It prepares drafts for you to review and send.
- It does not post journals to your accounting system or lock a period there.
- It does not delete documents, and it never proposes retiring a document that a
  control, a lender or an auditor relies on.
- The assistant cannot approve work, delete evidence, send messages, change
  permissions, post journals or close a period.

## 5. Feedback

The **Feedback** button (bottom right) opens a short form and then a draft in Outlook
addressed to the product owner. You review and press Send in Outlook yourself; the app
only opens the draft. If Outlook does not open, use "Open in my email app" or
"Copy email text".

## 6. Turning on the assistant in Live (optional)

In Live, an administrator pastes an OpenAI API key in **Settings → AI connection**, presses Test,
and picks a model from the list the account actually has access to. The key is stored
encrypted on the server and only ever shown masked. An OpenAI API account is billed
separately from a ChatGPT subscription. Without a key, the assistant still answers from
your records using fixed rules and says so.
