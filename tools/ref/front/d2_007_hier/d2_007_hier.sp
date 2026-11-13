.subckt inv11 a y vdd vss
MN y a vss vss nmos_rvt w=1680e-9 l=150e-9 nf=2 m=1
MP y a vdd vdd sky130_fd_pr__pfet_01v8 w=2100e-9 l=150e-9 nf=8
.ends inv11
.subckt d2_007_hier vdd vss in out
X0 in n0 vdd vss inv11
X1 n0 out vdd vss inv11
.ends d2_007_hier
