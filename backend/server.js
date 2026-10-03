require("dotenv").config();
const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const multer = require("multer");
const Database = require("better-sqlite3");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });
const PORT = Number(process.env.PORT || 5000);
const JWT_SECRET = process.env.JWT_SECRET || "change-me";
const OWNER_USERNAME = process.env.OWNER_USERNAME || "owner";
const OWNER_PASSWORD = process.env.OWNER_PASSWORD || "ChangeMe123!";

const dataDir = path.join(__dirname, "data");
const uploadDir = path.join(__dirname, "..", "frontend", "uploads");
fs.mkdirSync(dataDir, {recursive:true}); fs.mkdirSync(uploadDir,{recursive:true});
const db = new Database(path.join(dataDir,"bdpl.sqlite"));
db.pragma("journal_mode=WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS teams(
 id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,district TEXT NOT NULL,short_name TEXT NOT NULL,
 owner_name TEXT DEFAULT '',logo TEXT DEFAULT '',purse INTEGER NOT NULL DEFAULT 20000,spent INTEGER NOT NULL DEFAULT 0,
 max_squad INTEGER NOT NULL DEFAULT 16,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS players(
 id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,district TEXT DEFAULT '',role TEXT NOT NULL,
 base_price INTEGER NOT NULL DEFAULT 1000,sold_price INTEGER DEFAULT NULL,team_id INTEGER DEFAULT NULL,
 status TEXT NOT NULL DEFAULT 'available',jersey_no TEXT DEFAULT '',photo TEXT DEFAULT '',created_at TEXT DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY(team_id) REFERENCES teams(id));
CREATE TABLE IF NOT EXISTS auction(
 id INTEGER PRIMARY KEY CHECK(id=1),player_id INTEGER DEFAULT NULL,current_bid INTEGER NOT NULL DEFAULT 0,
 highest_team_id INTEGER DEFAULT NULL,status TEXT NOT NULL DEFAULT 'idle',ends_at INTEGER DEFAULT NULL,updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY(player_id) REFERENCES players(id),FOREIGN KEY(highest_team_id) REFERENCES teams(id));
CREATE TABLE IF NOT EXISTS matches(
 id INTEGER PRIMARY KEY AUTOINCREMENT,match_no INTEGER DEFAULT 1,team_a TEXT NOT NULL,team_b TEXT NOT NULL,venue TEXT DEFAULT 'ASP Stadium',
 match_date TEXT DEFAULT '',status TEXT NOT NULL DEFAULT 'upcoming',runs_a INTEGER DEFAULT 0,wickets_a INTEGER DEFAULT 0,overs_a TEXT DEFAULT '0.0',
 runs_b INTEGER DEFAULT 0,wickets_b INTEGER DEFAULT 0,overs_b TEXT DEFAULT '0.0',target INTEGER DEFAULT NULL,batting_team TEXT DEFAULT '',
 striker TEXT DEFAULT '',non_striker TEXT DEFAULT '',bowler TEXT DEFAULT '',last_event TEXT DEFAULT '',updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS balls(
 id INTEGER PRIMARY KEY AUTOINCREMENT,match_id INTEGER NOT NULL,inning INTEGER NOT NULL,over_no INTEGER NOT NULL,ball_no INTEGER NOT NULL,
 runs INTEGER DEFAULT 0,extras INTEGER DEFAULT 0,wicket INTEGER DEFAULT 0,event TEXT DEFAULT '',striker TEXT DEFAULT '',bowler TEXT DEFAULT '',
 created_at TEXT DEFAULT CURRENT_TIMESTAMP,FOREIGN KEY(match_id) REFERENCES matches(id));
CREATE TABLE IF NOT EXISTS standings(
 id INTEGER PRIMARY KEY AUTOINCREMENT,team_id INTEGER UNIQUE NOT NULL,played INTEGER DEFAULT 0,wins INTEGER DEFAULT 0,losses INTEGER DEFAULT 0,
 ties INTEGER DEFAULT 0,nrr REAL DEFAULT 0,points INTEGER DEFAULT 0,FOREIGN KEY(team_id) REFERENCES teams(id));
CREATE TABLE IF NOT EXISTS settings(
 id INTEGER PRIMARY KEY CHECK(id=1),event_name TEXT,organizer TEXT,location TEXT,auction_date TEXT,tournament_date TEXT,
 venue TEXT,contact1 TEXT,contact2 TEXT,squad_limit INTEGER DEFAULT 16,purse_limit INTEGER DEFAULT 20000,auction_seconds INTEGER DEFAULT 30);
CREATE TABLE IF NOT EXISTS leaderboard(
 id INTEGER PRIMARY KEY AUTOINCREMENT,player_id INTEGER UNIQUE NOT NULL,runs INTEGER DEFAULT 0,wickets INTEGER DEFAULT 0,matches INTEGER DEFAULT 0,
 FOREIGN KEY(player_id) REFERENCES players(id));
`);

const defaults={event_name:"BDPL – Bengal District Premier League",organizer:"Nilanjan & Shivam",location:"Durgapur, West Bengal",
auction_date:"25 October 2026",tournament_date:"10–13 December 2026",venue:"ASP Stadium",contact1:"8637862815",contact2:"7811978600",
squad_limit:16,purse_limit:20000,auction_seconds:30};
if(!db.prepare("SELECT id FROM settings WHERE id=1").get()) db.prepare(`INSERT INTO settings(id,event_name,organizer,location,auction_date,tournament_date,venue,contact1,contact2,squad_limit,purse_limit,auction_seconds)
VALUES(1,@event_name,@organizer,@location,@auction_date,@tournament_date,@venue,@contact1,@contact2,@squad_limit,@purse_limit,@auction_seconds)`).run(defaults);
// Keep the requested organizer name when upgrading an older BDPL V2 database.
const existingSettings=db.prepare("SELECT organizer FROM settings WHERE id=1").get();
if(existingSettings && existingSettings.organizer === "Jai Maheshwara Group") db.prepare("UPDATE settings SET organizer=? WHERE id=1").run(defaults.organizer);
if(!db.prepare("SELECT id FROM auction WHERE id=1").get()) db.prepare("INSERT INTO auction(id) VALUES(1)").run();

app.use(cors()); app.use(express.json()); app.use(express.urlencoded({extended:true}));
app.use(express.static(path.join(__dirname,"..","frontend")));
const storage=multer.diskStorage({destination:(_r,_f,cb)=>cb(null,uploadDir),filename:(_r,f,cb)=>cb(null,`upload-${Date.now()}-${Math.random().toString(36).slice(2)}${path.extname(f.originalname).toLowerCase()}`)});
const upload=multer({storage,limits:{fileSize:4*1024*1024},fileFilter:(_r,f,cb)=>cb(null,[".jpg",".jpeg",".png",".webp"].includes(path.extname(f.originalname).toLowerCase()))});

function auth(req,res,next){const h=req.headers.authorization||"";const t=h.startsWith("Bearer ")?h.slice(7):"";try{req.user=jwt.verify(t,JWT_SECRET);next()}catch{return res.status(401).json({error:"Owner login required."})}}
function settings(){return db.prepare("SELECT * FROM settings WHERE id=1").get()}
function publicState(){
 const teams=db.prepare(`SELECT t.*,COUNT(p.id) players_count FROM teams t LEFT JOIN players p ON p.team_id=t.id GROUP BY t.id ORDER BY t.name`).all();
 const players=db.prepare(`SELECT p.*,t.name team_name,t.short_name team_short_name FROM players p LEFT JOIN teams t ON t.id=p.team_id ORDER BY p.id DESC`).all();
 const auction=db.prepare(`SELECT a.*,p.name player_name,p.role player_role,p.base_price,p.district player_district,p.photo player_photo,
 t.name highest_team_name,t.short_name highest_team_short FROM auction a LEFT JOIN players p ON p.id=a.player_id LEFT JOIN teams t ON t.id=a.highest_team_id WHERE a.id=1`).get();
 const matches=db.prepare("SELECT * FROM matches ORDER BY match_date,match_no,id").all();
 const table=db.prepare(`SELECT s.*,t.name team_name,t.short_name team_short,t.logo FROM standings s JOIN teams t ON t.id=s.team_id ORDER BY s.points DESC,s.nrr DESC,s.wins DESC,t.name`).all();
 const leaderboard=db.prepare(`SELECT l.*,p.name,p.role,p.team_id,t.name team_name FROM leaderboard l JOIN players p ON p.id=l.player_id LEFT JOIN teams t ON t.id=p.team_id ORDER BY l.runs DESC,l.wickets DESC`).all();
 return {settings:settings(),teams,players,auction,matches,standings:table,leaderboard};
}
function emit(){io.emit("state:update",publicState())}

app.get("/api/public/state",(_r,res)=>res.json(publicState()));
app.get("/api/public/matches/:id/balls",(req,res)=>res.json(db.prepare("SELECT * FROM balls WHERE match_id=? ORDER BY id DESC").all(req.params.id)));

app.post("/api/auth/login",(req,res)=>{
 if(req.body.username!==OWNER_USERNAME||req.body.password!==OWNER_PASSWORD)return res.status(401).json({error:"Invalid owner credentials."});
 res.json({token:jwt.sign({username:req.body.username,role:"owner"},JWT_SECRET,{expiresIn:"12h"})});
});
app.get("/api/admin/state",auth,(_r,res)=>res.json(publicState()));

app.put("/api/admin/settings",auth,(req,res)=>{
 const d={...settings(),...req.body}; db.prepare(`UPDATE settings SET event_name=@event_name,organizer=@organizer,location=@location,auction_date=@auction_date,tournament_date=@tournament_date,venue=@venue,contact1=@contact1,contact2=@contact2,squad_limit=@squad_limit,purse_limit=@purse_limit,auction_seconds=@auction_seconds WHERE id=1`).run(d); emit(); res.json(settings());
});

app.post("/api/admin/teams",auth,upload.single("logo"),(req,res)=>{
 const s=settings(), {name,district,short_name,owner_name,max_squad}=req.body;if(!name||!district||!short_name)return res.status(400).json({error:"Team, district and short name are required."});
 const logo=req.file?`/uploads/${req.file.filename}`:"";const info=db.prepare(`INSERT INTO teams(name,district,short_name,owner_name,logo,purse,max_squad) VALUES(?,?,?,?,?,?,?)`)
 .run(name.trim(),district.trim(),short_name.trim().toUpperCase(),owner_name||"",logo,Number(s.purse_limit),Number(max_squad||s.squad_limit));db.prepare("INSERT OR IGNORE INTO standings(team_id) VALUES(?)").run(info.lastInsertRowid);emit();res.json({id:info.lastInsertRowid});
});
app.delete("/api/admin/teams/:id",auth,(req,res)=>{
 if(db.prepare("SELECT COUNT(*) c FROM players WHERE team_id=?").get(req.params.id).c)return res.status(400).json({error:"Reassign sold players before deleting this team."});
 db.prepare("DELETE FROM standings WHERE team_id=?").run(req.params.id);db.prepare("DELETE FROM teams WHERE id=?").run(req.params.id);emit();res.json({ok:true});
});
app.post("/api/admin/players",auth,upload.single("photo"),(req,res)=>{
 const {name,district,role,base_price,jersey_no}=req.body;if(!name||!role)return res.status(400).json({error:"Player name and role are required."});
 const photo=req.file?`/uploads/${req.file.filename}`:"";const info=db.prepare(`INSERT INTO players(name,district,role,base_price,jersey_no,photo) VALUES(?,?,?,?,?,?)`)
 .run(name,district||"",role,Number(base_price||1000),jersey_no||"",photo);db.prepare("INSERT OR IGNORE INTO leaderboard(player_id) VALUES(?)").run(info.lastInsertRowid);emit();res.json({id:info.lastInsertRowid});
});
app.delete("/api/admin/players/:id",auth,(req,res)=>{
 const p=db.prepare("SELECT * FROM players WHERE id=?").get(req.params.id);if(!p)return res.status(404).json({error:"Player not found."});
 if(p.status==="sold")return res.status(400).json({error:"Sold players cannot be deleted."});db.prepare("DELETE FROM leaderboard WHERE player_id=?").run(p.id);db.prepare("DELETE FROM players WHERE id=?").run(p.id);emit();res.json({ok:true});
});

app.post("/api/admin/auction/start",auth,(req,res)=>{
 const p=db.prepare("SELECT * FROM players WHERE id=?").get(Number(req.body.player_id));if(!p)return res.status(404).json({error:"Player not found."});
 if(p.status==="sold")return res.status(400).json({error:"Player is already sold."});const seconds=Number(req.body.seconds||settings().auction_seconds||30);
 db.prepare("UPDATE auction SET player_id=?,current_bid=?,highest_team_id=NULL,status='live',ends_at=?,updated_at=CURRENT_TIMESTAMP WHERE id=1").run(p.id,p.base_price,Date.now()+seconds*1000);emit();res.json(publicState().auction);
});
app.post("/api/admin/auction/bid",auth,(req,res)=>{
 const a=db.prepare("SELECT * FROM auction WHERE id=1").get(),team=db.prepare("SELECT * FROM teams WHERE id=?").get(Number(req.body.team_id)),p=db.prepare("SELECT * FROM players WHERE id=?").get(a.player_id);
 if(a.status!=="live"||!a.player_id||!team||!p)return res.status(400).json({error:"No valid live auction."});
 if(a.ends_at && Date.now()>a.ends_at)return res.status(400).json({error:"Auction timer has expired. Restart the player."});
 const inc=Math.max(100,Number(req.body.increment||500)),newBid=Math.max(a.current_bid+inc,p.base_price),count=db.prepare("SELECT COUNT(*) c FROM players WHERE team_id=?").get(team.id).c;
 if(count>=team.max_squad)return res.status(400).json({error:`${team.name} has reached its squad limit.`});
 if(team.purse<newBid)return res.status(400).json({error:`${team.name} cannot afford this bid.`});
 db.prepare("UPDATE auction SET current_bid=?,highest_team_id=?,ends_at=?,updated_at=CURRENT_TIMESTAMP WHERE id=1").run(newBid,team.id,Date.now()+settings().auction_seconds*1000);emit();res.json(publicState().auction);
});
app.post("/api/admin/auction/sold",auth,(req,res)=>{
 const a=db.prepare("SELECT * FROM auction WHERE id=1").get(),p=db.prepare("SELECT * FROM players WHERE id=?").get(a.player_id),t=db.prepare("SELECT * FROM teams WHERE id=?").get(a.highest_team_id);
 if(a.status!=="live"||!p||!t)return res.status(400).json({error:"A live auction with a highest bidder is required."});
 const count=db.prepare("SELECT COUNT(*) c FROM players WHERE team_id=?").get(t.id).c;if(count>=t.max_squad)return res.status(400).json({error:"Team squad limit reached."});
 const tx=db.transaction(()=>{db.prepare("UPDATE players SET status='sold',sold_price=?,team_id=? WHERE id=?").run(a.current_bid,t.id,p.id);db.prepare("UPDATE teams SET spent=spent+?,purse=purse-? WHERE id=?").run(a.current_bid,a.current_bid,t.id);db.prepare("UPDATE auction SET status='sold',ends_at=NULL WHERE id=1").run()});tx();emit();res.json({ok:true});
});
app.post("/api/admin/auction/unsold",auth,(req,res)=>{
 const a=db.prepare("SELECT * FROM auction WHERE id=1").get();if(a.status!=="live")return res.status(400).json({error:"No live auction."});
 db.prepare("UPDATE players SET status='unsold' WHERE id=?").run(a.player_id);db.prepare("UPDATE auction SET status='unsold',ends_at=NULL WHERE id=1").run();emit();res.json({ok:true});
});
app.post("/api/admin/auction/reset",auth,(_r,res)=>{db.prepare("UPDATE auction SET player_id=NULL,current_bid=0,highest_team_id=NULL,status='idle',ends_at=NULL WHERE id=1").run();emit();res.json({ok:true})});
app.post("/api/admin/players/:id/reopen",auth,(req,res)=>{db.prepare("UPDATE players SET status='available' WHERE id=? AND status='unsold'").run(req.params.id);emit();res.json({ok:true})});

app.post("/api/admin/matches",auth,(req,res)=>{
 const b=req.body;if(!b.team_a||!b.team_b)return res.status(400).json({error:"Both teams are required."});
 const x=db.prepare(`INSERT INTO matches(match_no,team_a,team_b,venue,match_date,status,batting_team,striker,non_striker,bowler,target) VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
 .run(Number(b.match_no||1),b.team_a,b.team_b,b.venue||settings().venue,b.match_date||"",b.status||"upcoming",b.batting_team||b.team_a,b.striker||"",b.non_striker||"",b.bowler||"",b.target?Number(b.target):null);emit();res.json({id:x.lastInsertRowid});
});
app.put("/api/admin/matches/:id",auth,(req,res)=>{
 const m=db.prepare("SELECT * FROM matches WHERE id=?").get(req.params.id);if(!m)return res.status(404).json({error:"Match not found."});const b={...m,...req.body};
 db.prepare(`UPDATE matches SET match_no=?,team_a=?,team_b=?,venue=?,match_date=?,status=?,runs_a=?,wickets_a=?,overs_a=?,runs_b=?,wickets_b=?,overs_b=?,target=?,batting_team=?,striker=?,non_striker=?,bowler=?,last_event=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
 .run(Number(b.match_no||1),b.team_a,b.team_b,b.venue,b.match_date,b.status,Number(b.runs_a||0),Number(b.wickets_a||0),b.overs_a||"0.0",Number(b.runs_b||0),Number(b.wickets_b||0),b.overs_b||"0.0",b.target?Number(b.target):null,b.batting_team||"",b.striker||"",b.non_striker||"",b.bowler||"",b.last_event||"",req.params.id);emit();res.json({ok:true});
});
app.delete("/api/admin/matches/:id",auth,(req,res)=>{db.prepare("DELETE FROM balls WHERE match_id=?").run(req.params.id);db.prepare("DELETE FROM matches WHERE id=?").run(req.params.id);emit();res.json({ok:true})});

app.post("/api/admin/matches/:id/ball",auth,(req,res)=>{
 const m=db.prepare("SELECT * FROM matches WHERE id=?").get(req.params.id);if(!m)return res.status(404).json({error:"Match not found."});
 const b=req.body,inning=Number(b.inning||1),overNo=Number(b.over_no||0),ballNo=Number(b.ball_no||1),runs=Number(b.runs||0),extras=Number(b.extras||0),wicket=Number(b.wicket||0);
 db.prepare(`INSERT INTO balls(match_id,inning,over_no,ball_no,runs,extras,wicket,event,striker,bowler) VALUES(?,?,?,?,?,?,?,?,?,?)`).run(m.id,inning,overNo,ballNo,runs,extras,wicket,b.event||"",b.striker||"",b.bowler||"");
 const col=inning===1?"a":"b"; const currentRuns=Number(m[`runs_${col}`]||0)+runs+extras;const currentW=Number(m[`wickets_${col}`]||0)+wicket;
 db.prepare(`UPDATE matches SET runs_${col}=?,wickets_${col}=?,last_event=?,striker=?,bowler=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(currentRuns,currentW,b.event||`${runs} run(s)`,b.striker||m.striker,b.bowler||m.bowler,m.id);
 if(b.striker_id){db.prepare("UPDATE leaderboard SET runs=runs+?,matches=matches+1 WHERE player_id=?").run(runs,Number(b.striker_id))}
 if(b.bowler_id&&wicket){db.prepare("UPDATE leaderboard SET wickets=wickets+? WHERE player_id=?").run(wicket,Number(b.bowler_id))}
 emit();res.json({ok:true});
});

app.put("/api/admin/standings/:teamId",auth,(req,res)=>{
 const b=req.body;db.prepare(`INSERT INTO standings(team_id,played,wins,losses,ties,nrr,points) VALUES(?,?,?,?,?,?,?)
 ON CONFLICT(team_id) DO UPDATE SET played=excluded.played,wins=excluded.wins,losses=excluded.losses,ties=excluded.ties,nrr=excluded.nrr,points=excluded.points`)
 .run(Number(req.params.teamId),Number(b.played||0),Number(b.wins||0),Number(b.losses||0),Number(b.ties||0),Number(b.nrr||0),Number(b.points||0));emit();res.json({ok:true});
});

io.on("connection",s=>s.emit("state:update",publicState()));
setInterval(()=>{const a=db.prepare("SELECT * FROM auction WHERE id=1").get();if(a.status==="live"&&a.ends_at&&Date.now()>a.ends_at){io.emit("auction:expired",{player_id:a.player_id});}},500);
app.get("*",(req,res)=>req.path.startsWith("/api/")?res.status(404).json({error:"Not found"}):res.sendFile(path.join(__dirname,"..","frontend","index.html")));
server.listen(PORT,()=>console.log(`BDPL V2 running: http://localhost:${PORT}`));