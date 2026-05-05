# COSA User Manual

---

## What Is COSA?

COSA is your behind-the-scenes tech assistant. It watches your Baanbaan POS system around the clock — checking that everything is running, orders are flowing, and nothing unusual is happening. When everything is fine, COSA stays quiet. When something needs your attention, it sends you an email.

You don't need to be technical to use COSA. You don't log in anywhere. You don't check a dashboard. You just read your email.

---

## First-Time Setup

Before COSA can work, it needs to be connected to your Baanbaan system and configured with your email. Your system administrator handles this by running the setup wizard:

```
npm run setup
```

The wizard walks through everything in about 5 minutes — finding your Baanbaan device on the network, creating a secure connection, and connecting to your email. You'll be asked for:

- The **6-digit setup PIN** shown on the Baanbaan device screen (or in your Baanbaan welcome email)
- Your **email address** — where COSA will send alerts
- A **dedicated Gmail address** for COSA to send from
- An **Anthropic API key** (the AI that powers COSA)

Once setup is complete, COSA starts watching your system immediately.

---

## Your COSA Email Address

Your system administrator set up a dedicated email address for COSA (something like `cosa.baanbaan@gmail.com`). COSA sends and receives through this address.

**Add it to your contacts** so COSA's emails don't land in spam.

To ask COSA a question, send an email to that address. To respond to COSA's alerts or permission requests, just reply.

---

## The Basic Idea

**No news is good news.** COSA checks your system every minute. If everything looks fine, you hear nothing. If something is wrong, COSA emails you right away.

Here's a typical week:

- **Monday through Sunday, every minute:** COSA silently checks your system. No email.
- **Tuesday, 2 PM:** Printer goes offline. COSA sends you an email within minutes.
- **Wednesday, 9 AM:** You ask COSA a question. COSA replies in about 2 minutes.

That's it. COSA handles the watching so you can focus on running your restaurant.

---

## Asking COSA a Question

Send a plain email to COSA's address. Write naturally, like you'd ask a staff member.

**Things you can ask:**

```
Is everything running okay?
```

```
The printer wasn't printing this morning. Is it working now?
```

```
How many orders came in yesterday?
```

```
We had some issues earlier today. What happened?
```

```
What are you currently watching for?
```

COSA will reply within about 2 minutes.

**You don't need to use special words or commands.** Just describe what you want to know.

---

## Automatic Monitoring — Condition Watchers

COSA checks a live snapshot of your Baanbaan system every minute. You can tell COSA to automatically alert you whenever a specific condition occurs.

### Setting Up a Watcher

Email COSA describing what you want to watch for:

```
Let me know whenever the printer status shows a fault or goes offline.
```

```
Alert me if there are more than 10 pending orders at the same time.
```

```
Tell me if the system hasn't had a backup in more than 24 hours.
```

COSA will:
1. Check the live system status to understand what data is available
2. Create a monitoring condition tailored to your request
3. Reply confirming it's set up, with a plain description of what it's watching for
4. Alert you automatically whenever that condition triggers (at most once every 30 minutes per condition)

### Managing Your Watchers

**See what COSA is watching for:**

```
What conditions are you currently monitoring?
```

COSA will list everything, including when each condition last triggered.

**Pause a watcher temporarily (e.g., during maintenance):**

```
Pause the printer fault watcher for now — we're servicing the printer today.
```

**Re-enable it later:**

```
Re-enable the printer watcher.
```

**Update a watcher:**

```
Update the pending orders watcher to trigger at 15 instead of 10.
```

**Remove a watcher entirely:**

```
Stop watching the printer fault condition.
```

### What a Watcher Alert Looks Like

```
Subject: [COSA] Alert: Printer fault or absent

Your printer is showing a fault.

Status: fault
Last seen OK: 2026-04-08 11:45 AM

This means receipts may not be printing. Orders are still being
saved — nothing is lost.

Quick checks:
- Is the printer powered on?
- Is the cable connected to the router?

Reply to this email if you'd like COSA to investigate further.
```

COSA won't send the same alert more than once every 30 minutes. If the condition is still active after 30 minutes, you'll get a follow-up.

---

## Alerts COSA Sends You

When COSA detects a problem on its own (not through a custom watcher), it emails you automatically.

---

### "Everything is fine" (you won't get this)

COSA doesn't email you when things are normal. Silence means your system is healthy.

---

### System trouble alert

```
Subject: [COSA] Alert: Baanbaan

Your Baanbaan system appears to be offline or unreachable.

COSA has been unable to connect to it for the past hour.

What this means for your business:
Your POS system may not be processing orders. Customers trying to
place orders through the app may be getting errors.

What to check:
- Is the Baanbaan device powered on?
- Is it connected to your WiFi or ethernet?
- Has there been a power outage or internet disruption?

If you restart the device and the problem continues, reply to
this email and COSA will investigate further.

I'll check again in 1 hour.
```

---

### Running slow alert

```
Subject: [COSA] Alert: Baanbaan

Your Baanbaan system is running but seems to be under strain.

It's still processing orders, but response times are slower than
normal. This could cause delays for customers at peak hours.

What to watch for:
- Orders taking longer than usual to appear on the kitchen display
- Slower receipt printing

No action is needed right now. COSA is monitoring this closely
and will let you know if it gets worse.
```

---

### Permission request

When COSA needs to do something that changes your system, it always asks first. See the next section.

---

## Giving COSA Permission (Approvals)

COSA will never change anything on your system without asking you first. When it needs your go-ahead, you'll receive an email like this:

```
Subject: [COSA] Permission Needed: Restart your POS system

COSA is requesting your permission to restart Baanbaan.

Why:
Your system has been running for 18 days without a restart and memory
usage has been climbing since yesterday. A quick restart (takes about
60 seconds) should clear this up and prevent slowdowns during dinner
service.

Your orders are safe — everything is saved before the restart.

To say YES, reply to this email with exactly:
  APPROVE-7TBPWR2N

To say NO, reply with: DENY

If you don't respond within 30 minutes, COSA will cancel the
request and leave things as they are.
```

### To approve

Reply with the code shown in the email. Copy and paste it exactly:

```
APPROVE-7TBPWR2N
```

COSA will see your reply within about a minute and proceed. You'll get a confirmation email when it's done.

### To deny

Reply with `DENY`. You can add a note if you want:

```
DENY — we're in the middle of dinner rush, please wait until after 10pm
```

COSA will cancel the request and reply to confirm.

### If you ignore it

After 30 minutes, the request automatically cancels. COSA will send you a note saying it let the request expire. Nothing will have changed. You can always ask COSA to try again later.

### The code is one-time only

Each `APPROVE-XXXXXXXX` code works exactly once. Don't reuse codes from old emails. If you try to use an expired or already-used code, COSA will tell you.

---

## Making Changes to Your System

For certain pre-approved actions, COSA can make changes on your behalf — updating an order status, pausing online ordering, and similar operations. These actions are configured by your system administrator and require your explicit approval before anything happens.

### Example: Pausing online ordering

If your kitchen gets overwhelmed and you need to pause incoming orders:

```
Please pause online ordering. We're swamped right now.
```

COSA will:
1. Confirm it can do this
2. Send you an approval request email with a brief description of the action
3. Wait for your `APPROVE-XXXXXXXX` reply before doing anything
4. Confirm when it's done

COSA will never take an irreversible action without your approval. The approval request always includes a plain-language description of what it's about to do and why.

### What COSA can and cannot change

Your system administrator configures which actions COSA is allowed to perform. COSA can only take actions on that pre-approved list — it cannot invent new ones or access systems not on the list.

---

## Understanding COSA's Replies

COSA always leads with the bottom line — what you need to know — and then explains.

**When things are fine:**
```
Everything is running normally.

Your POS system has been up for 3 days straight, all orders are
going through, and the printer is responding. Nothing needs
your attention.
```

**When there's an issue:**
```
Your printer has been offline for about 45 minutes.

Orders are still being accepted and saved — nothing is lost. But
receipts aren't printing right now.

Most likely cause: the printer lost power or its network connection.

Quick fix to try:
1. Check that the printer is powered on (green light on front panel)
2. Check the cable connecting it to your router

Once you've tried that, reply "I restarted the printer" and COSA
will confirm it's back online.
```

---

## What Runs Automatically Overnight

A few maintenance tasks run on their own without bothering you. You don't need to do anything — they're listed here just so you know what to expect.

### Security and software updates

Your Baanbaan device and the COSA device install operating-system security updates automatically:

- **Baanbaan: every night at 1:00 AM**, after closing time
- **COSA: every afternoon at 2:00 PM**

Most nights this finishes silently in a few minutes and you'll never notice. **If a major update needs a restart**, the device will reboot on its own about a minute after the update finishes. Your Baanbaan POS comes back up in roughly 30 seconds — well before opening the next morning.

**You'll only get an email if something goes wrong** with an update (network down, package conflict, etc.). The email looks like this:

```
Subject: [COSA] auto_patch run on Appliance: FAILURE

Status:               FAILURE
Packages upgraded:    0
Reboot required:      no

Error: <description of what failed>
```

If you see this, no immediate action is needed — the system keeps running on its current packages until COSA's next attempt the following night.

### Resource health checks

Every 5 minutes during business hours (8 AM – 9 PM), COSA checks that no single program on Baanbaan is using too much CPU or memory, and that the device as a whole still has memory headroom. If something exceeds the safe threshold and stays there for several minutes, you'll get an email like:

```
Subject: [COSA] Resource threshold exceeded

The Baanbaan device is using more memory than expected.

Process: bun (POS application)
Memory: 1,250 MB (threshold: 1,000 MB)
Sustained for: 15 minutes
```

This is usually a soft warning — orders keep going through — but it's a heads-up that a restart may be needed if the trend continues.

### Public-IP changes

Your internet provider sometimes rotates your public IP address. When that happens, COSA notices within a couple of minutes, updates the affected configuration files on Baanbaan, and restarts the relevant services so order routing keeps working. You won't get an email for routine IP changes — only if the recovery itself fails.

---

## What COSA Will Never Do Without Your Permission

- Restart your system
- Pause or resume online ordering
- Change any order status
- Change any settings
- Take any action that could interrupt service

COSA is read-only unless you explicitly approve otherwise. When in doubt, it asks. It will never make a guess and act on your behalf without your knowledge.

---

## Common Situations

### "The printer isn't working"

Email COSA:

```
The printer in the kitchen isn't printing. Can you check it?
```

COSA will check the printer status and tell you:
- Whether it's showing as online or offline
- When it last printed successfully
- What to check or try

### "I want an alert whenever the printer goes offline"

Email COSA:

```
Alert me whenever the printer status is offline or showing a fault.
```

COSA will set up a watcher and confirm. From then on, you'll get an email within minutes of the printer going offline — automatically, without you needing to ask.

### "Orders seem stuck"

Email COSA:

```
We have an order that's been sitting for 20 minutes and it's not going through to the kitchen. Can you look into it?
```

COSA will check the order status and walk you through what's happening.

### "Something felt slow today"

Email COSA:

```
The system felt sluggish around noon today. Did anything happen?
```

COSA will look at what it logged during that time and report back.

### "I want a quick status check"

Email COSA:

```
Quick check — is everything running okay right now?
```

COSA will run a full check and reply within 2 minutes.

### "What are you watching for?"

Email COSA:

```
What conditions are you currently monitoring?
```

COSA will list all active watchers with their descriptions and the last time each one triggered.

---

## Quick Reference

| Situation | What to do |
|---|---|
| Want to know if system is healthy | Email COSA: "Is everything running okay?" |
| Got a problem alert | Read it, follow any steps listed, reply if needed |
| Got a permission request | Reply `APPROVE-XXXXXXXX` to approve, or `DENY` to cancel |
| Printer is offline | Email COSA describing the issue |
| Orders seem stuck | Email COSA describing what you're seeing |
| Want auto-alerts for a condition | Email COSA: "Alert me when [condition]" |
| Want to see all your watchers | Email COSA: "What are you watching for?" |
| Want to pause a watcher | Email COSA: "Pause the [name] watcher" |
| Just want to ask anything | Email COSA in plain language |

---

## Advanced Mode

> This section is for operators who want more technical detail from COSA. If you're comfortable reading things like HTTP status codes, SSH connection logs, and database metrics — or if a developer is helping you manage the system — advanced mode gives you the full picture.

Advanced mode is turned on in the system configuration (in the `.env` file):

```
COSA_OPERATOR_MODE=advanced
```

In advanced mode, COSA includes technical details in its emails:

**Standard mode alert:**
```
Your system is having trouble and COSA can't reach it.
```

**Advanced mode alert:**
```
Baanbaan is unreachable.

SSH connection to 192.168.1.10 failed (timeout after 5s, 3 retries).
HTTP health checks could not be run (SSH prerequisite failed).

Process supervisor: unknown (SSH unavailable)
Last known state: healthy (checked 2026-03-29T14:00:00Z)
```

**Standard mode health report:**
```
Everything is running normally. System has been up for 3 days,
all checks passed.
```

**Advanced mode health report:**
```
Baanbaan is healthy.

- SSH: connected (192.168.1.10:22)
- HTTP /health: 200 OK — {"status":"ok","uptime_seconds":259200}
- HTTP /health/ready: 200 OK — {"ready":true}
- systemd baanbaan: active (running), uptime 3d 0h 0m, 0 restarts

Checked at: 2026-03-29T14:00:00.000Z
```

Advanced mode also unlocks more detailed watcher alerts (raw snapshot values, full error messages) and more technical answers to questions like database query results and session history. If you're troubleshooting with a developer, switching to advanced mode temporarily gives them the raw data they need.

---

## Frequently Asked Questions

**Does COSA ever email me just to check in?**
No. COSA only emails when there's a problem, when a watcher condition triggers, or when it needs your permission. Silence is good news.

**How quickly will COSA respond to my email?**
Usually within 2 minutes. COSA checks for new email every 60 seconds, then runs your question through its AI — that part takes about a minute.

**How quickly will COSA alert me when something goes wrong?**
COSA polls your system every minute. If a watcher condition triggers, you'll receive an email within about 1–2 minutes of the change happening.

**I got the same alert twice. Is something wrong?**
COSA suppresses repeated alerts for the same condition for 30 minutes. If you received two alerts more than 30 minutes apart, the condition triggered again after the cooldown expired — meaning the issue wasn't resolved.

**What if COSA is wrong about something?**
COSA can make mistakes. If its assessment doesn't match what you're seeing, just tell it: *"That doesn't seem right — the printer is actually working fine right now."* COSA will re-check and update.

**Can other people email COSA?**
No. COSA only responds to the email address configured as the operator. Emails from other addresses are ignored.

**What if I haven't heard from COSA in a while?**
Silence is normal when everything is healthy. But if you're ever unsure, just ask: *"Everything okay?"*

**What if COSA itself goes down?**
COSA runs on a separate device on your network. If that device loses power or connectivity, you won't receive emails. Contact your system administrator if COSA has been silent for more than a day and you're concerned.

**Is my order data safe?**
COSA never modifies your order data. It can read it (to answer your questions) but cannot change, delete, or export it. All access is logged.

**Can I ask COSA to watch for something it doesn't know about yet?**
Yes. COSA learns about your system from its live status endpoint. As long as the condition is reflected in that data, COSA can write a watcher for it. Just describe what you want to know about in plain language.
