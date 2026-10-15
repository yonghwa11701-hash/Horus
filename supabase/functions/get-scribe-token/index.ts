import { serve } from '../_shared/http.ts';
import { sessionRequest } from '../_shared/validation.ts';
import { getScribeToken } from '../_shared/sessions.ts';

serve(sessionRequest, getScribeToken);
