.subckt d2_003_dummy vdd vss inp inn o2 id
M1 id id vss vss nmos_lvt w=840e-9 l=150e-9 nf=8
M2 tail id vss vss nmos_lvt w=840e-9 l=150e-9 nf=8
M3 o1 inp tail vss nmos_lvt w=1680e-9 l=150e-9 nf=10
M4 o2 inn tail vss nmos_lvt w=1680e-9 l=150e-9 nf=10
M5 o1 o1 vdd vdd pmos_lvt w=2520e-9 l=150e-9 nf=4
M6 o2 o1 vdd vdd pmos_lvt w=2520e-9 l=150e-9 nf=4
M7 o1 vss vss vss nmos_lvt w=2100e-9 l=150e-9 nf=12
M8 o2 vdd vdd vdd pmos_lvt w=1050e-9 l=150e-9 nf=8
M9 o2 o2 o2 vss nmos_lvt w=2520e-9 l=150e-9 nf=10
.ends d2_003_dummy
