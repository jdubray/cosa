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

**No news is good news.** COSA checks your system every hour. If everything looks fine, you hear nothing. If something is wrong, COSA emails you right away.

Here's a typical week:

- **Monday through Sunday, every hour:** COSA silently checks your system. No email.
- **Tuesday, 2 PM:** Printer goes offline. COSA sends you an email within the hour.
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

COSA will reply within about 2 minutes.

**You don't need to use special words or commands.** Just describe what you want to know.

---

## Alerts COSA Sends You

When COSA detects a problem, it emails you. Here are the types of alerts you might receive:

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

## What COSA Will Never Do Without Your Permission

- Restart your system
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

---

## Quick Reference

| Situation | What to do |
|---|---|
| Want to know if system is healthy | Email COSA: "Is everything running okay?" |
| Got a problem alert | Read it, follow any steps listed, reply if needed |
| Got a permission request | Reply `APPROVE-XXXXXXXX` to approve, or `DENY` to cancel |
| Printer is offline | Email COSA describing the issue |
| Orders seem stuck | Email COSA describing what you're seeing |
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

Advanced mode also unlocks more detailed answers to questions like database query results, session history, and tool output. If you're troubleshooting with a developer, switching to advanced mode temporarily gives them the raw data they need.

---

## Frequently Asked Questions

**Does COSA ever email me just to check in?**
No. COSA only emails when there's a problem or when it needs your permission. Silence is good news.

**How quickly will COSA respond to my email?**
Usually within 2 minutes. COSA checks for new email every 60 seconds, then runs your question through its AI — that part takes about a minute.

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
