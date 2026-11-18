import {test} from 'node:test';import assert from 'node:assert/strict';
import {assertOrdinaryReply} from './ordinary-reply.mjs';
test('valid educational response is ordinary content, not necessarily a literal answer',()=>assertOrdinaryReply({clock_response:false,spoken:'我们来掰手指算一算呀～1根手指加1根手指，是几根呀😉'}));
for(const row of [{clock_response:false,spoken:''},{clock_response:true,spoken:'现在是两点'},{clock_response:false,spoken:'（小可暂时连不上大脑：upstream 502）'},{clock_response:false,spoken:'（小可有点累了：upstream 429）'}])test('reject invalid ordinary response '+JSON.stringify(row),()=>assert.throws(()=>assertOrdinaryReply(row)));
