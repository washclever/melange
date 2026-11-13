.subckt c1_002_tele vbiasn vbiasp1 vbiasp2 vinn vinp voutn voutp vdd 0
m1 id id 0 0 nmos_lvt w=1.68e-6 l=150e-9 nf=12 m=3
m2 net10 id 0 0 nmos_lvt w=1.68e-6 l=150e-9 nf=12 m=3
m5 voutn vbiasn net8 0 nmos_lvt w=0.84e-6 l=150e-9 nf=16
m6 voutp vbiasn net014 0 nmos_lvt w=0.84e-6 l=150e-9 nf=16
m8 voutp vbiasp1 net012 vdd sky130_fd_pr__pfet_01v8 w=2520e-9 l=150e-9 nf=10
m7 voutn vbiasp1 net06 vdd sky130_fd_pr__pfet_01v8 w=2520e-9 l=150e-9 nf=10
m10 net012 vbiasp2 vdd vdd pmos_lvt w=2.10e-6 l=150e-9 nf=6 m=1
m9 net06 vbiasp2 vdd vdd sky130_fd_pr__pfet_01v8 w=2.10e-6 l=150e-9 nf=6 m=1
m4 net014 vinn net10 0 nmos_lvt w=1.05e-6 l=150e-9 nf=8
m3 net8 vinp net10 0 nmos_lvt w=1.05e-6 l=150e-9 nf=8
.ends c1_002_tele
