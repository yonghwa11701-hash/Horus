import { serve } from '../_shared/http.ts';
import { transcriptRequest } from '../_shared/validation.ts';
import { appendTranscript } from '../_shared/sessions.ts';

serve(transcriptRequest, appendTranscript);
