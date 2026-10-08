class PCMProcessor extends AudioWorkletProcessor {
  constructor(){super();this.samples=[];this.position=0;this.step=sampleRate/16000;}
  process(inputs){const input=inputs[0]?.[0];if(!input)return true;
    while(this.position<input.length){const left=Math.floor(this.position),right=Math.min(left+1,input.length-1),fraction=this.position-left;const value=input[left]*(1-fraction)+input[right]*fraction;this.samples.push(Math.max(-32768,Math.min(32767,Math.round(value*32767))));this.position+=this.step;}
    this.position-=input.length;
    while(this.samples.length>=1600){const frame=new Int16Array(this.samples.splice(0,1600));this.port.postMessage(frame.buffer,[frame.buffer]);}return true;
  }
}
registerProcessor('pcm-processor',PCMProcessor);
