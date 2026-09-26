const {test}=require('node:test');
const assert=require('node:assert/strict');
const sharp=require('sharp');
const {matchFrame}=require('../src/vision');
const {findZoned}=require('../src/detect');
const {transform}=require('../src/resolution');
async function fixture(){
  const source=await sharp(Buffer.from('<svg width="60" height="40"><rect width="60" height="40" fill="#124a35"/><circle cx="20" cy="20" r="12" fill="#eee"/><path d="M38 10L51 20L38 30Z" fill="#f5b64a"/></svg>')).png().toBuffer();
  const frame=await sharp({create:{width:800,height:600,channels:3,background:'#829c8f'}}).composite([{input:source,left:300,top:220}]).png().toBuffer();return{source,frame};
}
for(const referenceWidth of [800,1280])for(const screenWidth of [800,1280])test(`${referenceWidth} template matches ${screenWidth} client and yields correct click`,async()=>{
  const {source,frame}=await fixture();
  const ratio=referenceWidth/800;
  const sourceAtReference=await sharp(source).resize(Math.round(60*ratio),Math.round(40*ratio)).png().toBuffer();
  const buffer=await sharp(frame).resize(screenWidth,screenWidth*3/4).png().toBuffer();
  const reference={width:referenceWidth,height:referenceWidth*3/4};
  const {match}=await matchFrame({buffer,source:sourceAtReference,area:{x:0,y:0,...reference},reference,asset:{reference_width:referenceWidth,region:{x:300*ratio,y:220*ratio,width:60*ratio,height:40*ratio}},threshold:.9});
  assert.ok(match);const point=transform({x:50,y:70,width:screenWidth,height:screenWidth*3/4},reference).point(match.x+match.width/2,match.y+match.height/2);
  assert.ok(Math.abs(point.x-(50+330*screenWidth/800))<=2);assert.ok(Math.abs(point.y-(70+240*screenWidth/800))<=2);
});
test('home and zone search return coordinates relative to a nonzero search origin',async()=>{
  const {source,frame}=await fixture();const area={x:250,y:180,width:200,height:160};
  const crop=await sharp(frame).extract({left:area.x,top:area.y,width:area.width,height:area.height}).png().toBuffer();
  for(const home of [null,{x:300,y:220,width:60,height:40}]){
    const match=await findZoned(crop,source,area,0,.9,null,home);assert.equal(match.x,50);assert.equal(match.y,40);
  }
});
test('reference changes scale stored assets before matching',async()=>{
 const {source,frame}=await fixture();const buffer=await sharp(frame).resize(1280,960).png().toBuffer();
 const {match}=await matchFrame({buffer,source,area:{x:0,y:0,width:1280,height:960},reference:{width:1280,height:960},asset:{reference_width:800,region:{x:300,y:220,width:60,height:40}},threshold:.9});assert.ok(match);assert.ok(Math.abs(match.x-480)<=1);
});
