import { serve } from '../_shared/http.ts';
import { updateSessionRequest } from '../_shared/validation.ts';
import { updateSession } from '../_shared/sessions.ts';

serve(updateSessionRequest, updateSession);
