.subckt d2_001_parallel vdd vss in vb out
M1 out in vss vss nmos_lvt w=1680e-9 l=150e-9 nf=10
M2 out in vss vss nmos_lvt w=1680e-9 l=150e-9 nf=10
M3 out in vss vss nmos_lvt w=1680e-9 l=150e-9 nf=10
M4 out vb vdd vdd pmos_rvt w=420e-9 l=150e-9 nf=2
M5 out vb vdd vdd pmos_rvt w=420e-9 l=150e-9 nf=2
.ends d2_001_parallel
