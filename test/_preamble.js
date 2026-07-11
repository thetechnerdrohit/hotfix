const ctx2d={fillStyle:'#000',font:'',textAlign:'',textBaseline:'',fillRect(){},fillText(){},measureText(){return{width:40};},clearRect(){},drawImage(){}};
globalThis.document={createElement(t){return t==='canvas'?{width:0,height:0,getContext:()=>ctx2d}:{style:{},appendChild(){},addEventListener(){}};},addEventListener(){},getElementById(){return null;}};
globalThis.window={addEventListener(){},devicePixelRatio:1};
