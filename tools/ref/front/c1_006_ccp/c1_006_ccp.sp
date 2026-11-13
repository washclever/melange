.subckt c1_006_ccp vss vdd clk outp outn
M1 outp outn vss vss nmos_rvt w=16.8e-7 l=150e-9 nf=8 m=2
M2 outn outp vss vss nmos_rvt w=16.8e-7 l=150e-9 nf=8 m=2
M3 outp outn vdd vdd pmos_rvt w=1.05e-6 l=150e-9 nf=16 stack=2
M4 outn outp vdd vdd pmos_rvt w=1.05e-6 l=150e-9 nf=16 stack=2
M5 outp clk vdd vdd pmos_rvt w=1.05e-6 l=150e-9 nf=20 m=3 stack=3
M6 outn clk vdd vdd pmos_rvt w=2100e-9 l=150e-9 nf=10 m=1
.ends c1_006_ccp
