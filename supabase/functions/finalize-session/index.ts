import { serve } from '../_shared/http.ts';
import { sessionRequest } from '../_shared/validation.ts';
import { finalizeSession } from '../_shared/agents.ts';

serve(sessionRequest, finalizeSession);
