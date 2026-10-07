"""Regression tests for source generation and acceptance failure paths."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import numpy as np
from sfx_synth import write_wav24, make_loop
from verify_audio import read_wav, verify
from make_reel import block

class AudioTests(unittest.TestCase):
    def test_reel_expands_decoded_mono_without_cutting_samples(self):
        samples=np.arange(5,dtype=float).reshape(-1,1)
        stereo=block(samples)
        self.assertEqual(stereo.shape,(5,2))
        np.testing.assert_array_equal(stereo[:,0],samples[:,0])
        np.testing.assert_array_equal(stereo[:,1],samples[:,0])

    def test_seed_is_stable_across_process_hash_seeds(self):
        code="from sfx_synth import synth; import hashlib; print(hashlib.sha256(synth('SFX-WPN-PISTOL-SHOT',1)[0].tobytes()).hexdigest())"
        results=[subprocess.check_output([sys.executable,'-c',code],cwd=Path(__file__).parent,env={**os.environ,'PYTHONHASHSEED':seed}) for seed in ['1','999']]
        self.assertEqual(results[0],results[1])

    def test_crossfade_starts_at_tail_continuation(self):
        loop=make_loop(lambda n:np.arange(n,dtype=float),1,.3,sr=10)
        self.assertEqual(loop[0],10)
        self.assertEqual(loop[-1],9)
        self.assertEqual(loop[2],2)

    def test_odd_pcm_chunk_is_padded_and_readable(self):
        with tempfile.TemporaryDirectory(prefix='aether-audio-test-') as directory:
            p=Path(directory)/'odd.wav';write_wav24(p,np.array([.5]))
            x,sr,ch,bits=read_wav(p)
            self.assertEqual((sr,ch,bits,x.shape),(48000,1,24,(1,1)))
            self.assertEqual(len(p.read_bytes())%2,0)

    def test_inventory_hash_and_format_failures_are_explicit(self):
        with tempfile.TemporaryDirectory(prefix='aether-audio-test-') as directory:
            root=Path(directory);cid='SFX-TEST';dest=root/cid;dest.mkdir();p=dest/'take.wav'
            with self.assertRaises(OSError):verify(root)
            (root/'batch.json').write_text(json.dumps({'cues':[]}),encoding='utf-8')
            with self.assertRaises(ValueError):verify(root)
            x=np.full(4800,.2);write_wav24(p,x)
            cue={'id':cid,'variants':1,'channels':1,'playback':'one-shot'}
            (root/'batch.json').write_text(json.dumps({'cues':[cue]}),encoding='utf-8')
            variant={'file':'take.wav','sha256':hashlib.sha256(p.read_bytes()).hexdigest(),'sampleRate':48000,'channels':1,'bitDepth':24,'frames':4800,'durationS':.1,'playback':'one-shot'}
            meta={'id':cid,'variants':[variant]};mp=dest/'delivery.json';mp.write_text(json.dumps(meta),encoding='utf-8')
            self.assertEqual(verify(root)[1],[]) # Quiet assets need not peak at exactly -3 dBFS.
            write_wav24(p,x*.5);self.assertTrue(any('hash mismatch' in f for f in verify(root)[1]))
            write_wav24(p,x,sr=44100);variant['sha256']=hashlib.sha256(p.read_bytes()).hexdigest();mp.write_text(json.dumps(meta),encoding='utf-8')
            self.assertTrue(any('format mismatch' in f for f in verify(root)[1]))
            cue['id']='../escape';(root/'batch.json').write_text(json.dumps({'cues':[cue]}),encoding='utf-8')
            with self.assertRaises(ValueError):verify(root)

if __name__=='__main__':unittest.main()
