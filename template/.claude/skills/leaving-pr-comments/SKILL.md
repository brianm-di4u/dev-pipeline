---
name: leaving-pr-comments
description: Use whenever leaving comments on GitHub.
---

# Leaving PR Comments

When you share an account with the human, every comment you leave must show plainly that an agent wrote it. Prefix it with this note:

```md
> [!NOTE]
> 🤖 **<model> responding on behalf of <user>**

Actual comment starts here.
```

Use the verified public name of the model that wrote the comment, and the user's name or GitHub login. If the harness doesn't expose a model name, use the harness name. Don't guess.

A delegate's session posts under its own account, so it leaves the note off: its login already says who wrote the comment.

Before posting, check the entire comment, including quoted text and attachments, for secrets and private details.

Keep the attribution inside the note and the reply outside it. The context line must start with the robot emoji. Don't add a horizontal rule, heading, signature footer, or second attribution.

Apply this to top-level PR comments, inline review comments, replies to bots or reviewers, and written reasons for dismissing feedback. Don't add it to PR descriptions or commit messages.

Write the comment itself in a direct style:

- Lead with the conclusion.
- Cite the relevant code, behavior, check, or reproduction.
- Keep it concise, without filler, canned thanks, or status narration.
- Distinguish verified facts from judgment.

Never write a comment whose whole body is `/approve`, `/decide`, or `/rearm`. Those commands belong to the human, and to a delegate's own session within its grant, through the `gardener` skill.

After posting, verify that GitHub returned the comment's URL. Resolve a review thread only after your response posted successfully.
