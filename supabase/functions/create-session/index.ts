import { serve } from '../_shared/http.ts';
import { createSessionRequest } from '../_shared/validation.ts';
import { createSession } from '../_shared/sessions.ts';

serve(createSessionRequest, createSession);
