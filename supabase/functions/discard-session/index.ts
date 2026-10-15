import { serve } from '../_shared/http.ts';
import { sessionRequest } from '../_shared/validation.ts';
import { discardSession } from '../_shared/sessions.ts';

serve(sessionRequest, discardSession);
