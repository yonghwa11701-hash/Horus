-- Asked is not answered: hide the live card while retaining the outstanding question.
-- Apply before deploying the updated process-segment and finalize-session functions.
-- Roll forward on rollback: leave this additive enum value; do not delete existing asked records.
alter type public.suggestion_status add value if not exists 'asked';
