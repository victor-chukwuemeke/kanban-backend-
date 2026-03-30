function inviteEmail({ boardName, inviterName, signupUrl }) {
  return {
    subject: `You've been invited to "${boardName}" on KanbanFlow`,
    html: `
      <div style="font-family: sans-serif; max-width: 500px; margin: 0 auto;">
        <h2>Board Invitation</h2>
        <p><strong>${inviterName}</strong> invited you to collaborate on <strong>${boardName}</strong>.</p>
        <p>Create your account to get started:</p>
        <a href="${signupUrl}"
           style="display: inline-block; padding: 12px 24px; background: #635FC7; color: #fff; text-decoration: none; border-radius: 6px;">
          Accept Invitation
        </a>
        <p style="margin-top: 24px; color: #666; font-size: 13px;">
          This invitation expires in 7 days. If you didn't expect this, you can ignore this email.
        </p>
      </div>
    `,
  };
}

module.exports = { inviteEmail };
