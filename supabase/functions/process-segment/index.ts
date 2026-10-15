import { serve } from '../_shared/http.ts';
import { processSegmentRequest } from '../_shared/validation.ts';
import { processSegment } from '../_shared/agents.ts';

serve(processSegmentRequest, processSegment);
