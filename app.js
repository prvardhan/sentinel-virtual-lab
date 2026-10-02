const $=id=>document.getElementById(id),rnd=(a,b)=>a+Math.random()*(b-a),clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
/* ---- /config ---- */
const C={hrHigh:130,hrLow:45,spo2Low:92,cap:500,iN:8,iA:25,iE:80,bleInt:2000,senInt:1000,fallAlone:'ALERT',depthCm:30,deepCm:100,stormRate:4};
const S={hr:78,sp:97,hrMode:'NORMAL',motion:'NORMAL',fall:false,water:'DRY',sos:false,bt:82,ble:'CONNECTED',loss:0,depth:0,storm:'STEADY',bp:1008};
/* ---- /core: sensor fusion + state machine (pure, portable to C) ---- */
function fuse(s,c){
 const fall=s.fall||s.motion==='FALL',still=s.motion==='NO_MOVEMENT',sub=s.depth>=c.depthCm,imm=s.water==='IMMERSION'||sub,active=s.motion==='WALKING'||s.motion==='RUNNING';
 const abn=s.hr>c.hrHigh||s.hr<c.hrLow||s.sp<c.spo2Low,R=(st,label,reason,sev,ev)=>({st,label,reason,sev,ev});
 if(s.sos)return R('EMERGENCY','EMERGENCY','SOS button pressed (R1)',3,['SOS']);
 if(imm&&fall)return R('EMERGENCY','EMERGENCY','Fall + Water Immersion (R2)'+(still?' + No Movement':''),3,['FALL','IMMERSION']);
 if(fall&&still&&abn)return R('EMERGENCY','EMERGENCY','Fall + No Movement + Abnormal vitals (R3)',3,['FALL','NO_MOVEMENT','HR/SpO2']);
 if(s.depth>=c.deepCm&&still)return R('EMERGENCY','EMERGENCY','Deep submersion (barometer) + No Movement (R7)',3,['BARO_DEPTH','NO_MOVEMENT']);
 if(imm&&still)return R('ALERT','ALERT (HIGH PRIORITY)','Immersion + No Movement (R4)',2,['IMMERSION','NO_MOVEMENT']);
 if(fall)return R(c.fallAlone,c.fallAlone,'Fall detected, not yet corroborated',c.fallAlone==='ALERT'?1:3,['FALL']);
 if(imm)return R('ALERT','ALERT','Water immersion',1,['IMMERSION']);
 if(s.sp<c.spo2Low&&s.motion==='ABNORMAL_MOTION')return R('ALERT','ALERT','Low SpO₂ + abnormal motion (R6)',1,['SPO2','ABNORMAL_MOTION']);
 if(s.hr>c.hrHigh&&active)return R('NORMAL','ACTIVE / MONITORING','High HR with active motion — exercise, not emergency (R5)',0,['HR','ACTIVE_MOTION']);
 return R('NORMAL','SAFE','All indicators nominal',0,[]);}
const MODEI=m=>m==='EMERGENCY'?C.iE:m==='ALERT'?C.iA:C.iN;
/* ---- runtime ---- */
let T=0,run=true,trend=0,pa=[],cur={st:'NORMAL',label:'SAFE',reason:'init',sev:0,ev:[]},prev='–',trT='–',tx=0,rx=0,lost=0,streak=0,recon=0,sinceTx=0,lastRx=null,emg=null,m={},mot={a:[0,0,1],g:[0,0,0]},I=8,logs=[],blog=[],H={hr:[],sp:[],bt:[],i:[]};
const LAT0=17.6200,LON0=83.4100,boat={x:0,y:0},wr={x:6,y:4};
const pos=o=>({lat:LAT0+o.y/111320,lon:LON0+o.x/(111320*Math.cos(LAT0*Math.PI/180))});
const ts=()=>{const t=Math.floor(T);return String(Math.floor(t/3600)).padStart(2,'0')+':'+String(Math.floor(t/60)%60).padStart(2,'0')+':'+String(t%60).padStart(2,'0')};
function measure(){let hr=S.hr,sp=S.sp;if(S.hrMode==='RANDOM'){hr+=rnd(-4,4);sp+=rnd(-1,1)}else if(S.hrMode==='ABNORMAL'){hr=150+rnd(-5,8);sp=88+rnd(-2,2)}
 m={hr:Math.round(clamp(hr,40,180)),sp:Math.round(clamp(sp,75,100)),motion:S.motion,fall:S.fall||S.motion==='FALL',water:S.water,sos:S.sos,depth:S.depth,wp:S.bp+S.depth*0.0981+rnd(-.03,.03)};
 const amp={NORMAL:.03,WALKING:.3,RUNNING:1.2,FALL:3.5,NO_MOVEMENT:0,ABNORMAL_MOTION:2}[S.motion];
 mot.a=[rnd(-amp,amp),rnd(-amp,amp),1+rnd(-amp,amp)];mot.g=[rnd(-1,1),rnd(-1,1),rnd(-1,1)].map(v=>v*amp*60);}
/* ---- /communication: packet protocol ---- */
const enc=o=>Object.entries(o).map(([k,v])=>k+'='+v).join(';')+';';
const dec=s=>Object.fromEntries(s.split(';').filter(Boolean).map(p=>p.split('=')));
function wristPacket(){return enc({DEVICE_ID:'SN001',HR:m.hr,SPO2:m.sp,FALL:+m.fall,WATER:+(m.water!=='DRY'),SOS:+m.sos,MOTION:m.motion,STATUS:cur.st==='NORMAL'?'SAFE':cur.st,BATTERY:Math.round(S.bt),DEPTH:Math.round(m.depth)})}
function blogAdd(ev,txt){blog.unshift(`<tr><td>${ts()}</td><td>${ev}</td><td class="mono">${txt}</td></tr>`);blog.length=Math.min(blog.length,30)}
function send(){const p=wristPacket();tx++;sinceTx=0;$('ptx').textContent=p;blogAdd('TX',p.slice(0,60)+'…');
 if(S.ble!=='CONNECTED'){lost++;blogAdd('DROP','no link ('+S.ble+')');return}
 if(Math.random()*100<S.loss){lost++;streak++;blogAdd('LOST','packet lost');if(streak>=3){S.ble='RECONNECTING';recon=5}return}
 streak=0;rx++;lastRx={...dec(p),t:ts()};blogAdd('RX','boat hub received');
 if(lastRx.STATUS==='EMERGENCY'&&!emg)emg={...pos(wr),t:ts(),wx:wr.x,wy:wr.y,bx:boat.x,by:boat.y};if(lastRx.STATUS!=='EMERGENCY')emg=null;}
/* ---- main step ---- */
function step(dt){T+=dt;measure();
 const f=fuse({hr:m.hr,sp:m.sp,motion:m.motion,fall:S.fall,water:m.water,sos:m.sos,depth:m.depth},C);let changed=false;
 if(f.st!==cur.st){prev=cur.st;trT=ts();changed=true}cur=f;
 // power
 const fs=clamp(.7+.3*1000/C.senInt,.3,3),fb=clamp(.85+.15*2000/C.bleInt,.3,3);I=MODEI(f.st)*fs*fb;
 if(dt>0){S.bt=Math.max(0,S.bt-(I*dt/3600)/C.cap*100)}
 if(S.ble==='RECONNECTING'&&dt>0){recon-=dt;if(recon<=0){S.ble='CONNECTED';streak=0}}
 // boat/wrist motion
 if(dt>0){S.bp-=({STEADY:0,FALLING:2,RAPID:6}[S.storm])*dt/3600;pa.push({t:T,p:S.bp});while(pa.length>1&&T-pa[0].t>300)pa.shift();trend=T-pa[0].t>=1?(S.bp-pa[0].p)/(T-pa[0].t)*10800:0;boat.x+=.2*dt;boat.y+=.05*dt;if(S.water==='IMMERSION'){wr.x+=.05*dt;wr.y-=.03*dt}else{wr.x=boat.x+6;wr.y=boat.y+4}}
 sinceTx+=dt;const iv=(f.st==='EMERGENCY'?C.bleInt/4:f.st==='ALERT'?C.bleInt/2:C.bleInt)/1000;
 if(changed||sinceTx>=iv)send();
 H.hr.push(m.hr);H.sp.push(m.sp);H.bt.push(S.bt);H.i.push(I);for(const k in H)if(H[k].length>150)H[k].shift();
 if(changed||dt>0&&Math.floor(T)%5<dt+0.0001||logs.length===0)logRow();
 render();}
function logRow(){const p=pos(wr);logs.push([ts(),'SN001',m.hr,m.sp,m.motion,+m.fall,m.water,+m.sos,S.bt.toFixed(1),p.lat.toFixed(5),p.lon.toFixed(5),cur.st,cur.reason]);if(logs.length>1000)logs.shift()}
/* ---- render ---- */
const stCls=s=>s==='NORMAL'?'SAFE':s;
function render(){const set=(i,v)=>{$(i).textContent=v};set('clk',Math.floor(T));
 const lab=stCls(cur.st);$('hdrState').textContent=cur.label.split(' (')[0];$('hdrState').className='pill '+lab;
 set('fs',cur.st);set('fl',cur.label);set('fp',prev);set('fv',cur.sev);set('ft',trT);set('fr',cur.reason);set('fe',cur.ev.join(', ')||'none');
 set('acc',mot.a.map(v=>v.toFixed(2)).join(', '));set('gyr',mot.g.map(v=>v.toFixed(0)).join(', '));
 const ori=S.motion==='FALL'||S.motion==='NO_MOVEMENT'&&S.fall?'horizontal (roll ~85°)':'upright';set('ori',ori);
 $('axes').innerHTML=mot.a.map((v,i)=>`<rect x="${10+i*100}" y="${25-clamp(Math.abs(v)-(i==2?1:0),0,4)*5}" width="60" height="${4+clamp(Math.abs(v)-(i==2?1:0),0,4)*5}" fill="var(--acc)"/><text x="${10+i*100}" y="48" fill="var(--mut)" font-size="10">${'XYZ'[i]} ${v.toFixed(2)}g</text>`).join('');
 set('bl',S.ble);set('bc',`${tx} / ${rx} / ${lost}`);$('blog').innerHTML=blog.join('');
 const bme={t:(29.4+Math.sin(T/60)*.3).toFixed(1),p:S.bp.toFixed(1),h:(78+Math.sin(T/90)*2).toFixed(0)},bp=pos(boat);
 set('bt1',bme.t+' °C');set('bt2',bme.p+' hPa');set('bt3',bme.h+' %');set('g1',bp.lat.toFixed(5)+', '+bp.lon.toFixed(5));set('g2','2.0 m / 0.4 kn');set('g3','9 / 3D FIX');
 const wp=pos(wr);
 const alt=44330*(1-Math.pow(S.bp/1013.25,.1903)),dd=m.wp-S.bp,storm=trend<=-C.stormRate;
 set('wp',m.wp.toFixed(2)+' hPa');set('bp2',S.bp.toFixed(1)+' hPa');set('dp2',dd.toFixed(2)+' hPa');set('de',(dd/.0981).toFixed(0)+' cm');set('tr',trend.toFixed(1)+' hPa/3h');set('ba',alt.toFixed(0)+' m');
 set('bs',m.depth>=C.deepCm?'DEEP SUBMERSION':m.depth>=C.depthCm?'SUBMERGED':storm?'STORM WARNING':'OK');$('bs').style.color=m.depth>=C.depthCm||storm?'var(--bad)':'var(--ok)';
 if(document.activeElement!==$('bpn'))$('bpn').value=S.bp.toFixed(1);
 $('hubpk').textContent=lastRx?enc({...lastRx,TEMP:bme.t,PRES:bme.p,HUM:bme.h,LAT:wp.lat.toFixed(5),LON:wp.lon.toFixed(5),SIM:1}):'(no packet received yet)';
 const pct=S.bt,V=3.0+1.2*Math.pow(pct/100,.6),rt=I>0?pct/100*C.cap/I:0;
 set('pb',pct.toFixed(1)+' %');set('pv',V.toFixed(2)+' V');set('pi',I.toFixed(1)+' mA');set('pm',cur.st);set('pr',rt>=1?rt.toFixed(1)+' h':(rt*60).toFixed(0)+' min');
 const w=pct<5?'CRITICAL POWER':pct<20?'LOW BATTERY':'OK';set('pw',w);$('pw').style.color=w==='OK'?'var(--ok)':'var(--bad)';
 // command center
 const L=lastRx;let h='';
 if(L&&L.STATUS==='EMERGENCY')h=`<div class="alertbox"><b style="font-size:18px">🚨 EMERGENCY</b><br>DEVICE: SN001<br>Reason: ${cur.reason}<br>Location: SIMULATED ${wp.lat.toFixed(5)}, ${wp.lon.toFixed(5)}<br>Time: ${L.t}</div>`;
 else if(L&&L.STATUS==='ALERT')h=`<div class="alertbox" style="border-color:var(--warn)"><b>⚠ ALERT</b> — ${cur.reason}</div>`;
 else h=`<div class="alertbox" style="border-color:var(--ok)"><b>SAFE</b> — ${L?L.STATUS==='SAFE'?cur.label:L.STATUS:'awaiting data'}</div>`;
 if(storm)h+=`<div class="alertbox" style="border-color:var(--warn)">⛈ STORM WARNING — boat pressure falling ${trend.toFixed(1)} hPa/3h</div>`;
 if(S.ble!=='CONNECTED')h+=`<div class="alertbox" style="border-color:var(--warn)">⚠ BLE ${S.ble} — data may be stale</div>`;
 if(pct<20)h+=`<div class="alertbox" style="border-color:var(--bad)">🔋 ${w}</div>`;
 $('cc').innerHTML=h;
 const g=k=>L?L[k]:'–';
 $('ccv').innerHTML=[['Device','SN001'],['Heart rate',g('HR')],['SpO₂',g('SPO2')],['Motion',g('MOTION')],['Fall',g('FALL')],['Water',g('WATER')],['SOS',g('SOS')],['Wrist battery',g('BATTERY')],['Temp / Pressure',bme.t+' °C / '+bme.p+' hPa'],['Wrist depth (baro)',m.depth+' cm'],['Lat / Lon',wp.lat.toFixed(5)+' / '+wp.lon.toFixed(5)],['GPS fix','3D (SIM)'],['BLE',S.ble],['Last packet',L?L.t:'–']].map(([a,b])=>`<span>${a}</span><b>${b}</b>`).join('');
 // map
 const pts=[boat,wr].concat(emg?[{x:emg.wx,y:emg.wy}]:[]),cx=pts.reduce((a,p)=>a+p.x,0)/pts.length,cy=pts.reduce((a,p)=>a+p.y,0)/pts.length;
 const span=Math.max(40,...pts.map(p=>Math.max(Math.abs(p.x-cx),Math.abs(p.y-cy))*2.6)),sc=200/span,X=p=>160+(p.x-cx)*sc,Y=p=>110-(p.y-cy)*sc;
 let svg='';for(let i=0;i<=8;i++){svg+=`<line x1="${i*40}" y1="0" x2="${i*40}" y2="220" stroke="var(--bd)"/><line x1="0" y1="${i*27.5}" x2="320" y2="${i*27.5}" stroke="var(--bd)"/>`}
 svg+=`<line x1="${X(boat)}" y1="${Y(boat)}" x2="${X(wr)}" y2="${Y(wr)}" stroke="var(--mut)" stroke-dasharray="3"/><rect x="${X(boat)-6}" y="${Y(boat)-4}" width="12" height="8" fill="var(--acc)"/><text x="${X(boat)+9}" y="${Y(boat)+3}" fill="var(--fg)" font-size="10">BOAT</text>`;
 svg+=`<circle cx="${X(wr)}" cy="${Y(wr)}" r="5" fill="${cur.st==='EMERGENCY'?'var(--bad)':'var(--ok)'}"/><text x="${X(wr)+8}" y="${Y(wr)+3}" fill="var(--fg)" font-size="10">WRIST SN001</text>`;
 if(emg)svg+=`<circle cx="${X({x:emg.wx,y:emg.wy})}" cy="${Y({x:emg.wx,y:emg.wy})}" r="11" fill="none" stroke="var(--bad)" stroke-width="2"/><text x="${X({x:emg.wx,y:emg.wy})+13}" y="${Y({x:emg.wx,y:emg.wy})-8}" fill="var(--bad)" font-size="10">EMERGENCY</text>`;
 svg+=`<text x="6" y="12" fill="var(--warn)" font-size="10" font-weight="700">SIMULATION — NOT REAL LOCATION</text><text x="6" y="214" fill="var(--mut)" font-size="9">grid ≈ ${(40/sc).toFixed(0)} m · ${wp.lat.toFixed(5)}, ${wp.lon.toFixed(5)}</text>`;$('map').innerHTML=svg;
 [['hr','--acc'],['sp','--ok'],['bt','--warn'],['i','--bad']].forEach(([k,c],i)=>chart('c'+i,H[k],c));drawFlow();
 $('lg').innerHTML=logs.slice(-12).reverse().map(r=>'<tr>'+r.map(x=>`<td>${x}</td>`).join('')+'</tr>').join('');}
function drawFlow(){const st=cur.st,sc=st==='EMERGENCY'?'--bad':st==='ALERT'?'--warn':'--ok',bc=S.ble==='CONNECTED'?sc:S.ble==='RECONNECTING'?'--warn':'--bad',T2=(x,y,t,sz=9,f='--mut',b=0)=>`<text x="${x}" y="${y}" text-anchor="middle" font-size="${sz}" ${b?'font-weight="700"':''} style="fill:var(${f})">${t}</text>`;
 const N=(x,y,w,h,t,v,c)=>`<rect class="node" x="${x}" y="${y}" width="${w}" height="${h}" rx="5" style="${c?'stroke:var('+c+');stroke-width:2':''}"/>`+T2(x+w/2,y+14,t,10,'--fg',1)+T2(x+w/2,y+27,v);
 const E=(x1,y1,x2,y2,l,c,on=1)=>`<line class="flow${on?'':' off'}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" style="stroke:var(${c})"/>`+T2((x1+x2)/2,(y1+y2)/2-4,l,8);
 const sens=[['MAX30102',`${m.hr} bpm · ${m.sp}%`,'I²C 0x57'],['BNO055',m.motion,'I²C 0x28'],['WATER',m.water,'ADC'],['SOS BUTTON',m.sos?'PRESSED':'off','GPIO IRQ'],['BARO (wrist)',m.wp.toFixed(1)+' hPa','I²C 0x77']];
 let g='';sens.forEach((a,i)=>{const y=10+i*52;g+=N(10,y,130,36,a[0],a[1],'')+E(140,y+18,220,clamp(y+18,75,185),a[2],sc,1)});
 g+=N(220,60,130,140,'WRIST ESP32','',sc)+T2(285,105,'SENSOR FUSION',9,'--fg')+T2(285,120,'↓',9)+T2(285,135,'EMERGENCY ENGINE',9,'--fg')+T2(285,155,cur.label.split(' (')[0],11,sc,1)+T2(285,175,I.toFixed(0)+' mA · '+cur.st,9);
 g+=E(350,130,470,130,`BLE · TX ${tx} · RX ${rx}`,bc,S.ble==='CONNECTED')+T2(410,148,S.ble,9,bc,1);
 g+=N(470,60,130,140,'BOAT ESP32','',bc)+T2(535,105,'RX: '+(lastRx?lastRx.t:'–'),9,'--fg')+T2(535,125,'merge wrist + boat',9)+T2(535,140,'+ location',9)+T2(535,165,lost+' lost',9);
 g+=N(440,235,110,36,'BME280',S.bp.toFixed(1)+' hPa','')+E(495,235,505,200,'I²C 0x76',sc)+N(575,235,110,36,'GNSS','9 sats · 3D (SIM)','')+E(630,235,580,200,'UART NMEA',sc);
 g+=E(600,130,650,130,'UART AT',sc,!!lastRx)+N(650,95,110,70,'SAT MODEM',emg?'SENDING SOS':'idle',emg?'--bad':'')+E(760,130,790,130,'SAT',sc,!!emg)+N(790,95,120,70,'COMMAND CENTER',st,sc);
 $('flow').innerHTML=g;
 const rows=[['MAX30102','Wrist ESP32','I²C 0x57','HR, SpO₂',`${m.hr} bpm / ${m.sp} %`],['BNO055','Wrist ESP32','I²C 0x28','accel, gyro, orientation → motion/fall',`${m.motion}, fall=${+m.fall}`],['Water sensor','Wrist ESP32','ADC','DRY / WET / IMMERSION',m.water],['SOS button','Wrist ESP32','GPIO interrupt','press event',m.sos?'PRESSED':'off'],['Barometer','Wrist ESP32','I²C 0x77','pressure → depth (cross-checks water)',`${m.wp.toFixed(2)} hPa → ${m.depth} cm`],['Fusion','Emergency engine','struct Inputs','state, reason, severity',`${cur.st} (sev ${cur.sev})`],['Wrist ESP32','Boat ESP32','BLE GATT notify','KEY=VAL packet',$('ptx').textContent.slice(0,48)+'…'],['BME280','Boat ESP32','I²C 0x76','temp, pressure, humidity, storm trend',`${S.bp.toFixed(1)} hPa, ${trend.toFixed(1)}/3h`],['GNSS','Boat ESP32','UART NMEA','lat, lon, alt, speed, fix','SIMULATED'],['Boat ESP32','Sat modem','UART AT','combined emergency packet',lastRx?'RX '+lastRx.t:'none yet'],['Sat modem','Command center','satellite uplink','alert + location',emg?'SOS at '+emg.t:'idle']];
 $('wire').innerHTML=rows.map(r=>'<tr>'+r.map(x=>`<td>${x}</td>`).join('')+'</tr>').join('')}
function chart(id,d,col){const c=$(id),w=c.width=c.clientWidth*devicePixelRatio,h=c.height=110*devicePixelRatio,x=c.getContext('2d');x.clearRect(0,0,w,h);if(d.length<2)return;
 const mn=Math.min(...d),mx=Math.max(...d),lo=mn-(mx-mn||2)*.2,hi=mx+(mx-mn||2)*.2,cs=getComputedStyle(document.documentElement);x.strokeStyle=cs.getPropertyValue(col)||'#4da3ff';x.lineWidth=2*devicePixelRatio;x.beginPath();
 d.forEach((v,i)=>{const px=i/(d.length-1)*w,py=h-(v-lo)/(hi-lo)*h;i?x.lineTo(px,py):x.moveTo(px,py)});x.stroke();x.fillStyle=cs.getPropertyValue('--mut');x.font=10*devicePixelRatio+'px monospace';x.fillText(hi.toFixed(1),3,12*devicePixelRatio);x.fillText(lo.toFixed(1),3,h-3);}
/* ---- UI wiring ---- */
function pair(r,n,key,conv=1){const f=v=>{S[key]=+v;$(r).value=v;$(n).value=Math.round(v);step(0)};$(r).oninput=e=>f(e.target.value);$(n).onchange=e=>f(e.target.value)}
pair('hr','hrn','hr');pair('sp','spn','sp');pair('bt','btn','bt');pair('dp','dpn','depth');
$('storm').onchange=e=>{S.storm=e.target.value;step(0)};$('bpn').onchange=e=>{S.bp=+e.target.value;pa=[];step(0)};
function syncUI(){$('hr').value=$('hrn').value=S.hr;$('sp').value=$('spn').value=S.sp;$('bt').value=S.bt;$('btn').value=Math.round(S.bt);$('hrMode').value=S.hrMode;$('motion').value=S.motion;$('fall').checked=S.fall;$('water').value=S.water;$('sos').textContent=S.sos?'PRESSED':'NORMAL';$('sos').className=S.sos?'on':'';$('loss').value=S.loss;$('lossv').textContent=S.loss;$('dp').value=$('dpn').value=S.depth;$('storm').value=S.storm}
$('hrMode').onchange=e=>{S.hrMode=e.target.value;step(0)};
$('motion').onchange=e=>{S.motion=e.target.value;if(S.motion==='FALL'){S.fall=true;syncUI()}step(0)};
$('fall').onchange=e=>{S.fall=e.target.checked;step(0)};$('water').onchange=e=>{S.water=e.target.value;step(0)};
$('sos').onclick=()=>{S.sos=!S.sos;syncUI();step(0)};
$('loss').oninput=e=>{S.loss=+e.target.value;$('lossv').textContent=S.loss};
$('bdis').onclick=()=>{S.ble='DISCONNECTED';step(0)};$('bcon').onclick=()=>{S.ble='CONNECTED';streak=0;step(0)};
$('speed').onchange=e=>{speed=+e.target.value};let speed=1;
$('run').onclick=()=>{run=!run;$('run').textContent=run?'⏸ Pause':'▶ Run'};
$('theme').onclick=()=>{const r=document.documentElement;r.dataset.theme=(r.dataset.theme||(matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light'))==='dark'?'light':'dark';render()};
function cfgInputs(el,list){$(el).innerHTML=list.map(([k,l])=>`<label>${l}<input type="number" id="cf_${k}" value="${C[k]}"></label>`).join('');list.forEach(([k])=>$('cf_'+k).onchange=e=>{C[k]=+e.target.value;step(0);runTests()})}
cfgInputs('cfgFus',[['hrHigh','HR high (bpm)'],['hrLow','HR low (bpm)'],['spo2Low','SpO₂ low (%)'],['depthCm','Submerged depth (cm)'],['deepCm','Deep submersion (cm)'],['stormRate','Storm drop (hPa/3h)']]);
cfgInputs('cfgPow',[['cap','Capacity (mAh)'],['iN','NORMAL current (mA)'],['iA','ALERT current (mA)'],['iE','EMERGENCY current (mA)'],['bleInt','BLE interval (ms)'],['senInt','Sensor interval (ms)']]);
$('fallAlone').onchange=e=>{C.fallAlone=e.target.value;step(0);runTests()};
/* ---- scenarios ---- */
const base={hr:78,sp:97,hrMode:'NORMAL',motion:'NORMAL',fall:false,water:'DRY',sos:false,bt:82,ble:'CONNECTED',depth:0,storm:'STEADY'};
const SC=[
['1 Normal',{},'SAFE'],['2 HighHR activity',{hr:160,motion:'RUNNING'},'ACTIVE / MONITORING (not emergency)'],
['3 Fall',{fall:true,motion:'NO_MOVEMENT'},'ALERT (or EMERGENCY if configured)'],['4 Fall+Still+Abn HR',{fall:true,motion:'NO_MOVEMENT',hr:145,sp:91},'EMERGENCY'],
['5 Immersion',{water:'IMMERSION'},'ALERT'],['6 Water+Fall+Still',{water:'IMMERSION',fall:true,motion:'NO_MOVEMENT'},'EMERGENCY'],
['7 SOS',{sos:true},'EMERGENCY (immediate)'],['8 BLE lost',{ble:'DISCONNECTED'},'Connection warning'],
['9 Low battery',{bt:15},'LOW BATTERY warning'],['10 Critical battery',{bt:3},'CRITICAL POWER warning'],['11 Submerged (barometer)',{depth:60},'ALERT — water sensor DRY but barometer shows ~60 cm'],['12 Deep + still',{depth:150,motion:'NO_MOVEMENT'},'EMERGENCY (R7)'],['13 Storm front',{storm:'RAPID'},'STORM WARNING in command center']];
$('scn').innerHTML=SC.map((s,i)=>`<button data-i="${i}">${s[0]}</button>`).join('');
$('scn').onclick=e=>{const i=e.target.dataset.i;if(i==null)return;Object.assign(S,base,SC[i][1]);S.bp=1008;pa=[];emg=null;syncUI();$('scnx').textContent='Expected: '+SC[i][2];step(0)};
/* ---- validation ---- */
function runTests(){const D={...C,fallAlone:'ALERT'},b={hr:78,sp:97,motion:'NORMAL',fall:false,water:'DRY',sos:false,depth:0};
 const T=[['SOS emergency',{sos:true},'EMERGENCY'],['Normal',{},'SAFE'],['High HR running',{hr:160,motion:'RUNNING'},'ACTIVE / MONITORING'],
 ['Fall only',{fall:true,motion:'NO_MOVEMENT'},'ALERT'],['Fall+still+abn HR',{fall:true,motion:'NO_MOVEMENT',hr:145,sp:91},'EMERGENCY'],
 ['Fall+still, normal vitals',{fall:true,motion:'NO_MOVEMENT'},'ALERT'],['Immersion',{water:'IMMERSION'},'ALERT'],
 ['Immersion+fall+still',{water:'IMMERSION',fall:true,motion:'NO_MOVEMENT'},'EMERGENCY'],['Immersion+still',{water:'IMMERSION',motion:'NO_MOVEMENT'},'ALERT (HIGH PRIORITY)'],
 ['Low SpO₂+abn motion',{sp:88,motion:'ABNORMAL_MOTION'},'ALERT'],['High HR resting, no fall',{hr:150},'SAFE'],['SOS overrides all',{sos:true,hr:70},'EMERGENCY'],['Water detected only',{water:'WATER_DETECTED'},'SAFE'],['Baro: submerged 50 cm',{depth:50},'ALERT'],['Baro: deep + still',{depth:150,motion:'NO_MOVEMENT'},'EMERGENCY'],['Baro: submerged + fall',{depth:50,fall:true},'EMERGENCY'],['Baro: shallow 10 cm',{depth:10},'SAFE']];
 let html='';T.forEach(([n,i,e])=>{const r=fuse({...b,...i},D).label,ok=r===e;html+=`<tr><td>${n}</td><td class="mono">${JSON.stringify(i)}</td><td>${e}</td><td>${r}</td><td class="${ok?'pass':'fail'}">${ok?'PASS':'FAIL'}</td></tr>`});
 // packet round-trip + battery warnings
 const pk={DEVICE_ID:'SN001',HR:'148',SOS:'0'},ok1=JSON.stringify(dec(enc(pk)))===JSON.stringify(pk);
 html+=`<tr><td>Packet encode/decode</td><td class="mono">${enc(pk)}</td><td>round-trip</td><td>${ok1}</td><td class="${ok1?'pass':'fail'}">${ok1?'PASS':'FAIL'}</td></tr>`;
 const r1=MODEI('EMERGENCY')>MODEI('ALERT')&&MODEI('ALERT')>MODEI('NORMAL');
 html+=`<tr><td>Power modes ordered</td><td class="mono">${C.iN}/${C.iA}/${C.iE} mA</td><td>N&lt;A&lt;E</td><td>${r1}</td><td class="${r1?'pass':'fail'}">${r1?'PASS':'FAIL'}</td></tr>`;$('tt').innerHTML=html;const n=(html.match(/>PASS</g)||[]).length,tot=(html.match(/>(PASS|FAIL)</g)||[]).length;$('qa').textContent=n+'/'+tot+' PASS';$('qa').style.color=n===tot?'var(--ok)':'var(--bad)'}
$('runT').onclick=runTests;runTests();
/* ---- log ---- */
$('lclr').onclick=()=>{logs=[];render()};
$('lcsv').onclick=async()=>{const t=$('csv'),h='Timestamp,Device ID,Heart Rate,SpO2,Motion,Fall,Water,SOS,Battery,Latitude,Longitude,System State,Reason';t.value=[h].concat(logs.map(r=>r.map(v=>`"${v}"`).join(','))).join('\n');t.hidden=false;t.select();try{await navigator.clipboard.writeText(t.value)}catch(e){}};
/* ---- start ---- */
syncUI();step(0);setInterval(()=>{if(run)step(speed)},1000);addEventListener('resize',render);
